/**
 * system-restore.ts — pi 配置的「系统还原」（Windows 11 系统还原思路）
 *
 * 入口命令：
 *   /snapshot [备注] [--force]  建还原点（默认自动去重；无备注时自动附变更摘要）
 *   /restore [id]               一键还原（预览差异 → 可选「完全还原」或「保留新增文件」→ 自动建撤销点 → reload）
 *   /snapshots [list|prune]     交互式管理面板（对比 diff / sha256 校验 / 还原 / 删除旧点 / 清理）
 *
 * 引擎在 ../lib/config-snapshot.mjs（同一份逻辑，CLI 也能跑）：
 *   node ~/.pi/agent/lib/config-snapshot.mjs list|create|diff|restore|verify|prune
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type SnapshotMeta = {
  id: string;
  createdAt: string;
  label: string;
  files: number;
  bytes: number;
  kind: string;
};

type DeltaSummary = {
  added: number;
  modified: number;
  removed: number;
  baseId?: string;
};

type Engine = {
  listSnapshots: () => Promise<SnapshotMeta[]>;
  createSnapshot: (opts: { label?: string; kind?: string; force?: boolean }) => Promise<{
    skipped: boolean;
    id?: string;
    latest?: string;
    counts?: { files: number; bytes: number };
    delta?: DeltaSummary | null;
  }>;
  planRestore: (id?: string) => Promise<{
    snapshot: SnapshotMeta;
    writes: { path: string; action: "add" | "modify" }[];
    removals: { path: string }[];
    unchanged: number;
  }>;
  verifySnapshot: (id?: string) => Promise<{
    ok: boolean;
    id: string;
    files: number;
    bad: string[];
  }>;
  deleteSnapshot: (id: string) => Promise<{
    id: string;
    label: string;
  }>;
  pruneSnapshots: (opts?: { keep?: number; dryRun?: boolean }) => Promise<{
    removed: string[];
    kept: number;
  }>;
  restoreSnapshot: (
    id: string,
    opts?: { dryRun?: boolean; keepExtra?: boolean; force?: boolean },
  ) => Promise<{
    id: string;
    written: string[];
    trashed: string[];
    keptExtra?: string[];
    preSnapshotId: string | null;
    failed: { path: string; error: string }[];
    verified: boolean;
  }>;
  describeSnapshot: (s: SnapshotMeta, index: number) => string;
  formatBytes: (n: number) => string;
};

let enginePromise: Promise<Engine> | null = null;
const engine = () =>
  (enginePromise ??= import(new URL("../lib/config-snapshot.mjs", import.meta.url).href) as unknown as Promise<Engine>);

function summarize(
  plan: {
    writes: { path: string; action: string }[];
    removals: { path: string }[];
    unchanged: number;
  },
  maxItems = 10,
): string {
  const lines = [
    `新增 ${plan.writes.filter((w) => w.action === "add").length} · 修改 ${plan.writes.filter((w) => w.action === "modify").length} · 当前多出 ${plan.removals.length} · 未变 ${plan.unchanged}`,
  ];
  const paths = [
    ...plan.writes.map((w) => `${w.action === "add" ? "+" : "~"} ${w.path}`),
    ...plan.removals.map((r) => `- ${r.path}`),
  ];
  const shown = paths.slice(0, maxItems);
  lines.push(...shown);
  if (paths.length > shown.length) lines.push(`… 还有 ${paths.length - shown.length} 项`);
  return lines.join("\n");
}

function fmtDelta(d?: DeltaSummary | null): string {
  if (!d) return "";
  return `（相对 ${d.baseId ?? "上一快照"}：+${d.added} 新增 · ~${d.modified} 修改 · -${d.removed} 移出）`;
}

async function doRestore(ctx: ExtensionCommandContext, arg: string): Promise<void> {
  const e = await engine();
  const snaps = await e.listSnapshots();
  if (!snaps.length) {
    ctx.ui.notify("还没有还原点。/snapshot 先建一个。", "warning");
    return;
  }

  let id = arg.trim();
  if (!id) {
    const shown = snaps.slice(0, 15);
    const options = shown.map((s, i) => e.describeSnapshot(s, i));
    const picked = await ctx.ui.select("还原到哪个还原点？", options);
    if (!picked) return;
    const idx = options.indexOf(picked);
    id = shown[idx]?.id ?? "";
    if (!id) return;
  }

  const plan = await e.planRestore(id);
  if (!plan.writes.length && !plan.removals.length) {
    ctx.ui.notify(`当前配置与还原点 ${plan.snapshot.id} 完全一致，无需还原。`, "info");
    return;
  }

  let keepExtra = false;
  if (plan.removals.length > 0 && ctx.hasUI) {
    ctx.ui.notify(
      `还原预览（目标 ${plan.snapshot.id}${plan.snapshot.label ? ` · ${plan.snapshot.label}` : ""}）：\n${summarize(plan)}`,
      "info",
    );
    const modeChoice = await ctx.ui.select(`确认还原到 ${plan.snapshot.id}？`, [
      `完全还原（将当前多出的 ${plan.removals.length} 个文件移入 trash，并自动建撤销点）`,
      `仅恢复旧文件，保留当前新增的 ${plan.removals.length} 个文件（--keep-extra）`,
      "取消",
    ]);
    if (!modeChoice || modeChoice === "取消") return;
    keepExtra = modeChoice.includes("--keep-extra");
  } else {
    const ok = await ctx.ui.confirm(
      `还原配置到 ${plan.snapshot.id}`,
      `${plan.snapshot.label ? plan.snapshot.label + "\n" : ""}${summarize(plan)}\n\n会先自动建「撤销点」；不会丢失当前状态。`,
    );
    if (!ok) return;
  }

  const r = await e.restoreSnapshot(plan.snapshot.id, { keepExtra });
  if (r.failed.length || !r.verified) {
    ctx.ui.notify(
      `还原有问题：写回 ${r.written.length}，失败 ${r.failed.length}，回读校验${r.verified ? "通过" : "失败"}\n撤销点：${r.preSnapshotId ?? "无"}`,
      "error",
    );
    return;
  }
  const extraNote = keepExtra ? `，保留新增 ${r.keptExtra?.length ?? 0} 个` : `，移出 ${r.trashed.length} 个到 trash`;
  ctx.ui.notify(
    `已还原到 ${r.id}：写回 ${r.written.length} 个文件${extraNote}\n撤销点：${r.preSnapshotId ?? "无"}\n扩展/技能已 reload；settings.json 与 mcp.json 需重启 pi 才生效。`,
    "info",
  );
  await ctx.reload();
}

async function manageSnapshots(ctx: ExtensionCommandContext, arg: string): Promise<void> {
  const e = await engine();
  const sub = arg.trim().toLowerCase();

  if (sub === "prune") {
    const preview = await e.pruneSnapshots({ dryRun: true });
    if (!preview.removed.length) {
      ctx.ui.notify(`无需清理：当前共 ${preview.kept} 个还原点，未超出默认保留上限。`, "info");
      return;
    }
    const ok = await ctx.ui.confirm(
      `清理 ${preview.removed.length} 个旧还原点？`,
      `将删除：${preview.removed.join(", ")}\n保留最近 ${preview.kept} 个。`,
    );
    if (!ok) return;
    const done = await e.pruneSnapshots({ dryRun: false });
    ctx.ui.notify(`已清理 ${done.removed.length} 个旧还原点，剩余 ${done.kept} 个。`, "info");
    return;
  }

  const list = await e.listSnapshots();
  if (!list.length) {
    ctx.ui.notify("还没有还原点。可用 /snapshot [备注] 新建。", "info");
    return;
  }

  if (sub === "list" || !ctx.hasUI) {
    ctx.ui.notify(list.slice(0, 15).map((s, i) => e.describeSnapshot(s, i)).join("\n"), "info");
    return;
  }

  const shown = list.slice(0, 15);
  const options = shown.map((s, i) => e.describeSnapshot(s, i));
  const picked = await ctx.ui.select(`配置还原点管理（共 ${list.length} 个，选一个查看或操作）`, options);
  if (!picked) return;
  const snap = shown[options.indexOf(picked)];
  if (!snap) return;

  const action = await ctx.ui.select(`${snap.id}${snap.label ? ` · ${snap.label}` : ""}`, [
    "对比差异（查看与当前配置的 diff）",
    "校验完整性（sha256）",
    "还原到此还原点",
    "删除此还原点",
    "关闭",
  ]);
  if (!action || action === "关闭") return;

  if (action.startsWith("对比差异")) {
    const plan = await e.planRestore(snap.id);
    if (!plan.writes.length && !plan.removals.length) {
      ctx.ui.notify(`当前配置与 ${snap.id} 完全一致，无差异。`, "info");
    } else {
      ctx.ui.notify(`对比 ${snap.id} → 当前配置：\n${summarize(plan, 16)}`, "info");
    }
    return;
  }

  if (action.startsWith("校验完整性")) {
    const v = await e.verifySnapshot(snap.id);
    ctx.ui.notify(
      v.ok ? `✓ ${v.id} 校验通过（${v.files} 个文件 sha256 全部一致）` : `✗ ${v.id} 校验失败：${v.bad.length} 个文件损坏\n${v.bad.slice(0, 8).join("\n")}`,
      v.ok ? "info" : "error",
    );
    return;
  }

  if (action.startsWith("还原到此")) {
    await doRestore(ctx, snap.id);
    return;
  }

  if (action.startsWith("删除此")) {
    if (list.length <= 1) {
      ctx.ui.notify("至少保留 1 个还原点，未执行删除。", "warning");
      return;
    }
    const ok = await ctx.ui.confirm(`确认删除还原点 ${snap.id}？`, `${snap.label ? `备注：${snap.label}\n` : ""}删除后无法恢复该还原点。`);
    if (!ok) return;
    await e.deleteSnapshot(snap.id);
    ctx.ui.notify(`已删除还原点 ${snap.id}。`, "info");
  }
}

export default function systemRestore(pi: ExtensionAPI) {
  pi.registerCommand("snapshot", {
    description: "为当前 pi 配置建一个还原点（/snapshot [备注] [--force]）",
    handler: async (args, ctx) => {
      try {
        const e = await engine();
        const raw = args.trim();
        const force = /(?:^|\s)--force(?:\s|$)/i.test(raw);
        const label = raw.replace(/(?:^|\s)--force(?:\s|$)/gi, " ").trim();
        const r = await e.createSnapshot({ label, force });
        if (r.skipped) {
          ctx.ui.notify(`配置与最新还原点 ${r.latest} 完全一致，跳过重复建点（如需强建请加 --force）`, "info");
          return;
        }
        ctx.ui.notify(
          `已建还原点 ${r.id}：${r.counts?.files ?? 0} 个文件，${e.formatBytes(r.counts?.bytes ?? 0)}${fmtDelta(r.delta)}`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`建还原点失败：${(err as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("restore", {
    description: "一键把 pi 配置还原到某个还原点（支持保留新增文件）",
    handler: async (args, ctx) => {
      try {
        await doRestore(ctx, args);
      } catch (err) {
        ctx.ui.notify(`还原失败：${(err as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("snapshots", {
    description: "管理配置还原点（diff / 校验 / 还原 / 删除 / prune）",
    handler: async (args, ctx) => {
      try {
        await manageSnapshots(ctx, args);
      } catch (err) {
        ctx.ui.notify(`读取还原点失败：${(err as Error).message}`, "error");
      }
    },
  });
}
