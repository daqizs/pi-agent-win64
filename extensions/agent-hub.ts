/**
 * agent-hub.ts —— 轻量 Agent Hub 子智能体控制台（/hub）
 *
 * 借鉴 oh-my-pi 的 Agent Hub，复用本地 pi-subagents 的异步运行快照
 * （%TEMP%/pi-subagents-<scope>/async-subagent-runs/<id>/status.json）：
 *   - 交互式列出所有运行中 / 已完成 / 失败 / 疑似失活的子智能体；
 *   - 选中后可查看最新状态/日志尾部，或对卡住的运行中子智能体一键安全终止。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface HubRun {
	runId: string;
	state: string;
	alive: boolean;
	pid?: number;
	startedAt?: number;
	endedAt?: number;
	mtimeMs: number;
	label: string;
	error?: string;
	dir: string;
}

const ACTIVE_STATES = new Set(["running", "queued", "pending", "scheduled", "started", "steering"]);
const FAILED_STATES = new Set(["failed", "error", "timeout", "timed_out", "cancelled", "canceled", "aborted", "killed"]);

function isPidAlive(pid?: number): boolean {
	if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return err?.code !== "ESRCH";
	}
}

function fmtElapsed(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function discoverRuns(): HubRun[] {
	const roots: string[] = [];
	const override = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	if (override) {
		roots.push(path.join(path.resolve(override), "async-subagent-runs"));
	} else {
		const tmp = os.tmpdir();
		try {
			for (const name of fs.readdirSync(tmp)) {
				if (name.startsWith("pi-subagents-")) {
					roots.push(path.join(tmp, name, "async-subagent-runs"));
				}
			}
		} catch {
			// 忽略无法读取临时目录
		}
	}

	const runs: HubRun[] = [];
	for (const root of roots) {
		let ids: string[] = [];
		try {
			ids = fs.readdirSync(root);
		} catch {
			continue;
		}
		for (const id of ids) {
			if (id.startsWith(".")) continue;
			const dir = path.join(root, id);
			const file = path.join(dir, "status.json");
			try {
				const raw = JSON.parse(fs.readFileSync(file, "utf8"));
				if (!raw || typeof raw !== "object") continue;
				const st = fs.statSync(file);
				const steps = Array.isArray(raw.steps) ? raw.steps : [];
				const stepLabel = steps
					.map((s: any) => s?.agent || s?.sessionName)
					.filter(Boolean)
					.slice(0, 2)
					.join(" + ");
				const state = String(raw.state ?? "unknown").toLowerCase();
				const pid = typeof raw.pid === "number" ? raw.pid : undefined;
				runs.push({
					runId: String(raw.runId ?? id),
					state,
					alive: isPidAlive(pid),
					pid,
					startedAt: typeof raw.startedAt === "number" ? raw.startedAt : undefined,
					endedAt: typeof raw.endedAt === "number" ? raw.endedAt : undefined,
					mtimeMs: st.mtimeMs,
					label: stepLabel || String(raw.agent ?? raw.name ?? id.slice(0, 12)),
					error: raw.error ? String(raw.error) : undefined,
					dir,
				});
			} catch {
				// 跳过半写入或已清理记录
			}
		}
	}

	return runs.sort((a, b) => {
		const aActive = ACTIVE_STATES.has(a.state) && a.alive ? 1 : 0;
		const bActive = ACTIVE_STATES.has(b.state) && b.alive ? 1 : 0;
		if (aActive !== bActive) return bActive - aActive;
		return (b.startedAt ?? b.mtimeMs) - (a.startedAt ?? a.mtimeMs);
	});
}

function readTailPreview(dir: string): string {
	const candidates = ["output.txt", "stdout.log", "stderr.log", "result.json", "status.json"];
	for (const name of candidates) {
		const p = path.join(dir, name);
		try {
			if (!fs.existsSync(p)) continue;
			const text = fs.readFileSync(p, "utf8").trim();
			if (!text) continue;
			const lines = text.split(/\r?\n/);
			const tail = lines.slice(-14).join("\n");
			return `[${name} 末尾 ${Math.min(lines.length, 14)}/${lines.length} 行]\n${tail}`;
		} catch {
			// 继续尝试下一个文件
		}
	}
	return "（该目录暂无可读日志或输出文件）";
}

function badgeOf(run: HubRun): string {
	if (ACTIVE_STATES.has(run.state)) return run.alive ? "● 运行中" : "◌ 疑似失活";
	if (FAILED_STATES.has(run.state)) return "✗ 失败";
	if (run.state === "complete" || run.state === "completed") return "✓ 完成";
	return `· ${run.state}`;
}

export default function agentHub(pi: ExtensionAPI) {
	async function openHub(ctx: any) {
		const runs = discoverRuns();
		if (!runs.length) {
			ctx.ui.notify("Agent Hub: 当前没有异步子智能体运行记录（仅跟踪 pi-subagents 后台任务）", "info");
			return;
		}

		const now = Date.now();
		const shown = runs.slice(0, 20);
		const options = shown.map((r) => {
			const dur = fmtElapsed((r.endedAt ?? now) - (r.startedAt ?? r.mtimeMs));
			const pidText = r.pid ? ` · PID ${r.pid}` : "";
			return `[${badgeOf(r)}] ${r.label} (${r.runId.slice(0, 8)}) · ${dur}${pidText}`;
		});

		if (!ctx.hasUI) {
			ctx.ui.notify(`Agent Hub (${runs.length} 条):\n${options.join("\n")}`, "info");
			return;
		}

		const picked = await ctx.ui.select(`Agent Hub · 共 ${runs.length} 条异步子智能体记录`, options);
		if (!picked) return;
		const idx = options.indexOf(picked);
		const run = shown[idx];
		if (!run) return;

		const actions = ["查看最新输出 / 状态详情"];
		if (run.alive && run.pid) actions.push(`终止进程 (PID ${run.pid})`);
		actions.push("关闭");

		const act = await ctx.ui.select(`${run.label} (${run.runId.slice(0, 8)}) · ${badgeOf(run)}`, actions);
		if (!act || act === "关闭") return;

		if (act.startsWith("查看")) {
			const header = `Run: ${run.runId} · 状态: ${badgeOf(run)}${run.error ? `\n错误: ${run.error}` : ""}\n目录: ${run.dir}`;
			ctx.ui.notify(`${header}\n\n${readTailPreview(run.dir)}`, "info");
			return;
		}

		if (act.startsWith("终止") && run.pid) {
			const ok = await ctx.ui.confirm("确认终止子智能体？", `将强制结束进程 PID ${run.pid}（${run.label}）及其子进程。`);
			if (!ok) return;
			const killRes =
				process.platform === "win32"
					? await pi.exec("taskkill", ["/PID", String(run.pid), "/T", "/F"])
					: await pi.exec("kill", ["-TERM", String(run.pid)]);
			if (killRes.code === 0) {
				ctx.ui.notify(`Agent Hub: 已终止子智能体 PID ${run.pid}`, "info");
			} else {
				ctx.ui.notify(`Agent Hub: 终止 PID ${run.pid} 失败：${killRes.stderr || "进程可能已退出"}`, "warning");
			}
		}
	}

	pi.registerCommand("hub", {
		description: "打开 Agent Hub：查看/检视/终止后台子智能体",
		handler: async (_arg, ctx) => openHub(ctx),
	});
}
