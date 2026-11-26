import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 读取 pi-subagents 落盘的运行快照（每个异步 run 一个 status.json），
// 汇总成一张给模型看的舰队表：数量、任务名、状态、耗时、失败原因、并发。
//
// 口径（必须随输出一起声明，别让快照被当成实时）：
// - 数据源是文件快照，不是进程内存；跨会话可见，但存在写入延迟。
// - 只覆盖异步/后台 run；前台阻塞式 subagent 不落 status.json。
// - 记录的 state 说 running 不等于真在跑：要再验 pid 存活 / 活动时间 / deadline。

type StepRecord = {
  agent?: string;
  sessionName?: string;
  status?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
};

type RunRecord = {
  runId: string;
  state: string;
  startedAt?: number;
  endedAt?: number;
  lastActivityAt?: number;
  lastUpdate?: number;
  deadlineAt?: number;
  pid?: number;
  error?: string;
  steps?: StepRecord[];
  parallelGroups?: unknown[];
  dir: string;
  /** status.json 的 mtime：文件级最后写入时间，用作活动时间的兜底 */
  fileMtime?: number;
};

type Liveness = "alive" | "dead" | "unknown";

type Verdict = {
  kind: "running" | "stale" | "failed" | "done" | "other";
  why?: string;
  /** 没有核实到进程启动时间：只能算“疑似在跑”，不能当确认 */
  unproven?: boolean;
};

const ACTIVE = new Set(["running", "queued", "pending", "scheduled", "started", "steering"]);
const FAILED = new Set(["failed", "error", "timeout", "timed_out", "cancelled", "canceled", "aborted", "killed"]);
const DONE = new Set(["complete", "completed"]);
/** 无 pid、无 deadline 时，多久没更新就算疑似过期 */
const STALE_INACTIVITY_MS = 10 * 60_000;
/** 进程创建时间比记录启动时间晚这么多，就当成 pid 被复用了 */
const PID_REUSE_TOLERANCE_MS = 10_000;
/** 每次调用最多查几次进程启动时间（一次一个子进程，不能让成本失控） */
const MAX_START_LOOKUPS = 8;

function runRoots(): string[] {
  // 不假设 /tmp 存在：统一走 os.tmpdir()，再用 path.join 拼。
  const override = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  if (override) return [path.join(path.resolve(override), "async-subagent-runs")];
  const tmp = os.tmpdir();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith("pi-subagents-"))
    .map((name) => path.join(tmp, name, "async-subagent-runs"));
}

function readRuns(): { runs: RunRecord[]; unreadable: string[] } {
  const runs: RunRecord[] = [];
  const unreadable: string[] = [];
  for (const root of runRoots()) {
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(root);
    } catch {
      continue; // 目录不存在 / 无权限：该 scope 静默跳过
    }
    for (const id of ids) {
      if (id.startsWith(".")) continue;
      const file = path.join(root, id, "status.json");
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!raw || typeof raw !== "object") throw new Error("not an object");
        runs.push({
          ...raw,
          runId: String(raw.runId ?? id),
          state: String(raw.state ?? "unknown"),
          steps: Array.isArray(raw.steps) ? raw.steps : [],
          parallelGroups: Array.isArray(raw.parallelGroups) ? raw.parallelGroups : [],
          dir: path.join(root, id),
          fileMtime: fs.statSync(file).mtimeMs,
        });
      } catch {
        // 半写入（正在被写）、损坏、已被 retention 清理：跳过但计数，不阻断整张表。
        unreadable.push(id);
      }
    }
  }
  return { runs, unreadable };
}

function pidLiveness(pid?: number): Liveness {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ESRCH" ? "dead" : "alive"; // EPERM = 进程存在
  }
}

function lastActivity(run: RunRecord): number | undefined {
  return run.lastActivityAt ?? run.lastUpdate ?? run.fileMtime ?? run.startedAt;
}

/**
 * 进程创建时间（毫秒）。拿不到就返回 undefined —— 宁可说“未核实”，也不拿 pid 当铁证。
 * pid 存活只能证明“这个号现在有主人”；pid 会被复用，必须用创建时间对齐记录里的 startedAt。
 */
async function processStartMs(pid: number): Promise<number | undefined> {
  const win = process.platform === "win32";
  const file = win ? "powershell.exe" : "ps";
  const args = win
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { $p.CreationDate.ToUniversalTime().ToString("o") }`,
      ]
    : ["-o", "lstart=", "-p", String(pid)];
  return await new Promise((resolve) => {
    execFile(file, args, { timeout: 2500, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(undefined);
      const ms = Date.parse(String(stdout).trim());
      resolve(Number.isFinite(ms) ? ms : undefined);
    });
  });
}

/** 记录的 state 说活着，到底还活着没有 */
async function settle(run: RunRecord, budget: { lookups: number }): Promise<Verdict> {
  if (FAILED.has(run.state)) return { kind: "failed" };
  if (DONE.has(run.state)) return { kind: "done" };
  if (!ACTIVE.has(run.state)) return { kind: "other" };

  // 已完成但从没回写 endedAt 的记录，同样按过期处理
  const alive = pidLiveness(run.pid);
  if (alive === "dead") return { kind: "stale", why: `记录为 ${run.state}，但进程 ${run.pid} 已退出（残留记录）` };

  const now = Date.now();
  if (typeof run.deadlineAt === "number" && run.deadlineAt < now) {
    return { kind: "stale", why: `记录为 ${run.state}，但已越过 deadline ${new Date(run.deadlineAt).toLocaleTimeString()}` };
  }
  const activity = lastActivity(run);
  if (activity && now - activity > STALE_INACTIVITY_MS) {
    return { kind: "stale", why: `记录为 ${run.state}，但已 ${formatGap(now - activity)} 无更新` };
  }

  // pid 活着也不等于原进程活着：要求「进程创建时间不晚于记录启动时间」
  if (alive === "alive" && budget.lookups > 0) {
    budget.lookups -= 1;
    const startedMs = await processStartMs(run.pid!);
    if (startedMs !== undefined) {
      if (run.startedAt && startedMs > run.startedAt + PID_REUSE_TOLERANCE_MS) {
        return {
          kind: "stale",
          why: `pid ${run.pid} 属于一个比记录启动时间晚 ${formatGap(startedMs - run.startedAt)} 才创建的进程（pid 已被复用）`,
        };
      }
      return { kind: "running" }; // 进程身份与记录对得上
    }
    return { kind: "running", unproven: true }; // 查不到创建时间：只能说未核实
  }

  // 没 pid，或查证次数用尽：只有“最近有写入”这一条证据
  return { kind: "running", unproven: true };
}

function formatGap(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}m`;
}

function duration(run: RunRecord, now: number): string {
  if (!run.startedAt) return "-";
  const end = run.endedAt ?? now;
  const sec = Math.max(0, Math.round((end - run.startedAt) / 100) / 10);
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  return `${min}m${String(Math.round(sec - min * 60)).padStart(2, "0")}s`;
}

function label(run: RunRecord): string {
  const steps = run.steps ?? [];
  const named = steps.find((s) => s.sessionName?.trim()) ?? steps.find((s) => s.agent);
  const raw = named?.sessionName?.trim() || named?.agent || "(未命名)";
  const oneLine = raw.replace(/\s+/g, " ").trim();
  const extra = steps.length > 1 ? ` (+${steps.length - 1} 步)` : "";
  return (oneLine.length > 56 ? `${oneLine.slice(0, 55)}…` : oneLine) + extra;
}

function agents(run: RunRecord): string {
  const names = [...new Set((run.steps ?? []).map((s) => s.agent).filter(Boolean))] as string[];
  return names.length ? names.join("+") : "-";
}

function failure(run: RunRecord): string | undefined {
  const direct = run.error ?? (run.steps ?? []).map((s) => s.error).find(Boolean);
  if (!direct) return undefined;
  const oneLine = String(direct).replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 159)}…` : oneLine;
}

/** 只看日志文件在不在，不读内容（读尾部留给需要的场景，避免输出过长） */
function outputLogs(run: RunRecord): string[] {
  try {
    return fs
      .readdirSync(run.dir)
      .filter((name) => /^output-\d+\.log$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

function pad(text: string, width: number): string {
  // 中文占两列，按显示宽度补空格
  const display = [...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 0x2e80 ? 2 : 1), 0);
  return text + " ".repeat(Math.max(0, width - display));
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent_fleet",
    label: "Subagent Fleet",
    description:
      "查异步 Subagent 的运行记录：有多少在跑、任务名、状态（运行中/疑似过期/失败/已完成）、耗时、失败原因、并发数。当用户问「现在有几个 subagent」「哪个失败了」「刚派的活怎么样了」，或需要判断能不能再并行派活时用。返回的是落盘快照（含采集时间与过期判定），不是进程实时状态；只覆盖异步/后台 run，不含前台阻塞式子 agent。",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "最多列出多少条运行记录（默认 15，最多 50）" },
        includeCompleted: { type: "boolean", description: "是否包含已完成/已失败的记录（默认 true）" },
      },
    },
    async execute(_toolCallId, params) {
      const limit = Math.min(50, Math.max(1, Number(params?.limit) || 15));
      const includeCompleted = params?.includeCompleted !== false;
      const capturedAt = new Date();
      const now = capturedAt.getTime();

      const { runs: all, unreadable } = readRuns();
      const roots = runRoots().filter((r) => fs.existsSync(r));
      if (!all.length && !unreadable.length) {
        return {
          content: [
            {
              type: "text",
              text: `没有 subagent 运行记录。\n采集于 ${capturedAt.toLocaleTimeString()}\n扫描目录：\n${roots.length ? roots.map((r) => `- ${r}`).join("\n") : "- （未找到 pi-subagents 临时根目录）"}`,
            },
          ],
        };
      }

      const budget = { lookups: MAX_START_LOOKUPS }; // 一次调用的总预算，所有记录共用
      const settled = await Promise.all(
        all.map(async (run) => ({ run, verdict: await settle(run, budget) })),
      );
      const counts = { running: 0, stale: 0, failed: 0, done: 0, other: 0 };
      for (const { verdict } of settled) counts[verdict.kind] += 1;

      const peakSteps = all.reduce((n, run) => Math.max(n, run.steps?.length ?? 0, run.parallelGroups?.length ?? 0), 0);

      const visible = settled.filter(({ verdict }) => includeCompleted || verdict.kind === "running" || verdict.kind === "stale");
      const shown = visible
        .sort((a, b) => {
          const rank = (k: string) => (k === "running" ? 0 : k === "stale" ? 1 : k === "failed" ? 2 : 3);
          const delta = rank(a.verdict.kind) - rank(b.verdict.kind);
          return delta || (b.run.startedAt ?? 0) - (a.run.startedAt ?? 0);
        })
        .slice(0, limit);

      const statusText = (kind: string, state: string, unproven?: boolean) =>
        kind === "stale"
          ? "stale!"
          : kind === "done"
            ? "complete"
            : kind === "running"
              ? unproven
                ? "running?"
                : "running"
              : state;
      const headers = ["runId", "状态", "耗时", "Agent", "任务"];
      const rows = shown.map(({ run, verdict }) => [
        run.runId.slice(0, 8),
        statusText(verdict.kind, run.state, verdict.unproven),
        duration(run, now),
        agents(run),
        label(run),
      ]);
      const widths = headers.map((h, i) => Math.max(pad(h, 0).length, ...rows.map((r) => pad(r[i], 0).length)));
      const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i])).join("  ").trimEnd();

      const lines: string[] = [];
      lines.push(`Subagent 运行记录 · 采集于 ${capturedAt.toLocaleTimeString()} · ${all.length} 条记录 / ${roots.length} 个运行目录`);
      lines.push(`扫描根：${roots.length ? roots.join("  ") : "（未找到）"}`);
      lines.push(
        `记录中运行 ${counts.running} · 疑似过期 ${counts.stale} · 失败 ${counts.failed} · 已完成 ${counts.done}${counts.other ? ` · 其它 ${counts.other}` : ""}`,
      );
      lines.push(
        `口径：「记录中运行」= 已落盘且仍活跃的异步 run 数，不等于 Pi 全局并发——其它实例、前台阻塞式子 agent 都不在此口径内${peakSteps > 1 ? `；单次运行最多 ${peakSteps} 步并行` : ""}。`,
      );
      if (shown.some(({ verdict }) => verdict.unproven))
        lines.push(`「running?」= 没核实到进程启动时间，只凭最近有写入判断，不等于确认在跑。`);
      if (unreadable.length)
        lines.push(`跳过 ${unreadable.length} 条无法解析的记录（正在写入或已损坏）：${unreadable.map((id) => id.slice(0, 8)).join(", ")}`);

      if (rows.length) {
        lines.push("");
        lines.push(line(headers));
        for (const row of rows) lines.push(line(row));
      }

      const notes: string[] = [];
      if (visible.length < settled.length) notes.push(`已隐藏 ${settled.length - visible.length} 条已结束记录`);
      if (shown.length < visible.length) notes.push(`按运行中优先 + 最近优先截取 ${shown.length}/${visible.length} 条`);
      if (notes.length) lines.push(`\n（共 ${all.length} 条：${notes.join("；")}）`);

      const stale = shown.filter(({ verdict }) => verdict.kind === "stale");
      if (stale.length) {
        lines.push("\n疑似过期（记录说在跑，实际存疑）：");
        for (const { run, verdict } of stale) lines.push(`- ${run.runId.slice(0, 8)} ${agents(run)}：${verdict.why}`);
      }

      const failures = shown.map(({ run, verdict }) => ({ run, reason: failure(run), kind: verdict.kind })).filter((f) => f.reason);
      if (failures.length) {
        lines.push("\n失败原因：");
        for (const { run, reason } of failures) {
          const logs = outputLogs(run);
          lines.push(`- ${run.runId.slice(0, 8)} ${agents(run)}（${duration(run, now)}）：${reason}`);
          lines.push(`  日志：${logs.length ? logs.join(", ") : "无 output-*.log"} · 目录：${run.dir}`);
        }
      }

      const live = shown.filter(({ verdict }) => verdict.kind === "running");
      if (live.length) {
        lines.push("\n运行中可查详情：");
        for (const { run } of live) lines.push(`- ${run.runId} → ${run.dir}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}
