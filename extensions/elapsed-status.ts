/**
 * elapsed-status —— 会话效率统计：页脚一行 + /stats 明细块。
 *
 * 视觉风格跟 pi 自己的页脚对齐：不用 emoji（会落到非等宽字体、字形大小不一致），
 * 不用裸 ANSI 色号，一律走 ctx.ui.theme，换主题时跟着变。
 *
 * 计时口径（互不重叠，加得起来）：
 *   - 累计：session_start 到现在的墙钟时间 = 活跃 + 空闲
 *   - 活跃：每个 turn_start → turn_end 的时长之和（模型在跑 + 工具在执行）
 *   - 空闲：累计 − 活跃，即等用户输入 / 挂机 / 阅读的时间
 *   - 工具：所有 tool_execution_end 的 durationMs 之和（单调时钟，精确）
 *   - 模型：按回合算「回合时长 − 该回合工具耗时」再求和
 *
 * 注意：不要用「累计 − 工具」当模型往返 —— 那会把挂机时间算成模型很慢。
 * 一个回合（turn）指一次模型请求，一轮对话可能产生多个回合（每次调工具算一个）。
 *
 * 命令：
 *   /stats        明细块（时间拆分 / 交互 / 工具成功率 / tokens 与成本 / 效率提示）
 *   /stats --json 同一份数据的 JSON
 *   /elapsed      /stats 的别名
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 只用到 fg / bold 两个方法，避免把扩展绑死在 Theme 的完整实现上。 */
interface StyleLike {
	fg(color: "dim" | "success" | "warning" | "error", text: string): string;
	bold(text: string): string;
}

const PLAIN: StyleLike = { fg: (_c, t) => t, bold: (t) => t };

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function fmt(ms: number): string {
	if (ms < 1000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rs = s % 60;
	if (m < 60) return rs ? `${m}m${String(rs).padStart(2, "0")}s` : `${m}m`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

function fmtSec(ms: number): string {
	return `${(Math.max(0, ms) / 1000).toFixed(2)}s`;
}

function fmtK(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function pct(v: number): string {
	return `${Math.round(v * 100)}%`;
}

/** 终端显示宽度：CJK / 全角字符占 2 列，用于对齐标签列。 */
function width(s: string): number {
	let w = 0;
	for (const ch of s) {
		const c = ch.codePointAt(0) ?? 0;
		const wide =
			c >= 0x1100 &&
			(c <= 0x115f ||
				c === 0x2329 ||
				c === 0x232a ||
				(c >= 0x2e80 && c <= 0xa4cf) ||
				(c >= 0xac00 && c <= 0xd7a3) ||
				(c >= 0xf900 && c <= 0xfaff) ||
				(c >= 0xfe30 && c <= 0xfe6f) ||
				(c >= 0xff00 && c <= 0xff60) ||
				(c >= 0xffe0 && c <= 0xffe6));
		w += wide ? 2 : 1;
	}
	return w;
}

function pad(s: string, target: number): string {
	return s + " ".repeat(Math.max(1, target - width(s)));
}

/** 活跃占比配色：沿用 pi 的语义色（success / warning / error）。 */
function toneOf(ratio: number): "success" | "warning" | "error" {
	if (ratio >= 0.3) return "success";
	if (ratio >= 0.15) return "warning";
	return "error";
}

interface Tokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function emptyTokens(): Tokens {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** 与 pi 内置 usage 汇总同口径：assistant 消息 / usage 条目 / toolResult 与压缩摘要的可选 usage。 */
function addUsage(t: Tokens, usage: any): void {
	if (!usage) return;
	t.input += usage.input ?? 0;
	t.output += usage.output ?? 0;
	t.cacheRead += usage.cacheRead ?? 0;
	t.cacheWrite += usage.cacheWrite ?? 0;
	t.cost += usage.cost?.total ?? 0;
}

function seedTokens(entries: readonly any[]): Tokens {
	const t = emptyTokens();
	for (const entry of entries ?? []) {
		if (entry?.type === "message" && entry.message?.role === "assistant") addUsage(t, entry.message.usage);
		else if (entry?.type === "usage") addUsage(t, entry.usage);
		else if (entry?.type === "message" && entry.message?.role === "toolResult") addUsage(t, entry.message.usage);
		else if (entry?.type === "branch_summary" || entry?.type === "compaction") addUsage(t, entry.usage);
	}
	return t;
}

interface SessionStats {
	wall: number;
	active: number;
	idle: number;
	activeRatio: number;
	turns: number;
	avgActivePerTurn: number;
	longestIdle: number;
	longestIdleAfterTurn: number;
	tools: {
		calls: number;
		ok: number;
		failed: number;
		ms: number;
		avgMs: number;
		shareOfActive: number;
		top: { name: string; calls: number; ms: number }[];
	};
	model: { totalMs: number; avgPerTurnMs: number; shareOfActive: number };
	usage: Tokens;
	hints: string[];
}

const TOP_TOOLS = 3;

/** 页脚一行。整体 dim（与 pi 自带 tokens 行同权重），只有活跃占比用语义色。 */
function oneLine(s: SessionStats, st: StyleLike): string {
	const ratio = `(${pct(s.activeRatio)})`;
	return (
		st.fg("dim", `累计 ${fmt(s.wall)} · 活跃 ${fmt(s.active)} `) +
		st.fg(toneOf(s.activeRatio), ratio) +
		st.fg(
			"dim",
			` · ${s.turns}回合 · 均 ${fmtSec(s.avgActivePerTurn)}/回合 · ` +
				`工具 ${fmt(s.tools.ms)} · 模型 ${fmt(s.model.totalMs)}`,
		)
	);
}

/** 明细块。缩进对齐、纯等宽字符，不混 emoji / 制表符。 */
function cardLines(s: SessionStats, st: StyleLike): string[] {
	const row = (label: string, value: string) => `${st.fg("dim", pad(label, 10))}${value}`;
	const L: string[] = [];
	L.push(st.bold("会话统计"));
	L.push("");
	L.push(row("总时长", fmt(s.wall)));
	L.push(row("活跃", `${fmt(s.active)} (${pct(s.activeRatio)})`));
	L.push(row("  模型", `${fmt(s.model.totalMs)} (${pct(s.model.shareOfActive)} 的活跃) · 均 ${fmtSec(s.model.avgPerTurnMs)}/回合`));
	L.push(row("  工具", `${fmt(s.tools.ms)} (${pct(s.tools.shareOfActive)} 的活跃)`));
	L.push(row("空闲", `${fmt(s.idle)} (${pct(s.wall > 0 ? s.idle / s.wall : 0)})`));
	L.push("");
	L.push(st.bold("交互"));
	L.push(row("回合", `${s.turns} · 均活跃 ${fmtSec(s.avgActivePerTurn)}/回合`));
	if (s.longestIdle > 0) {
		const where = s.longestIdleAfterTurn > 0 ? `（第 ${s.longestIdleAfterTurn} 回合后）` : "（会话开始时）";
		L.push(row("最长空闲", `${fmt(s.longestIdle)}${where}`));
	}
	L.push("");
	L.push(st.bold("工具"));
	L.push(row("调用", `${s.tools.calls} 次 · 成功 ${s.tools.ok} · 失败 ${s.tools.failed} · 均 ${fmtSec(s.tools.avgMs)}/次`));
	if (s.tools.top.length > 0) {
		L.push(row("最多", s.tools.top.map((t) => `${t.name} ${t.calls}次/${fmt(t.ms)}`).join(" · ")));
	}
	L.push("");
	L.push(st.bold("模型 / 成本"));
	const promptTokens = s.usage.input + s.usage.cacheRead + s.usage.cacheWrite;
	L.push(
		row(
			"输入",
			`${fmtK(s.usage.input)} · 输出 ${fmtK(s.usage.output)}` +
				(s.usage.cacheRead > 0
					? ` · 缓存命中 ${fmtK(s.usage.cacheRead)} (${pct(s.usage.cacheRead / Math.max(1, promptTokens))})`
					: ""),
		),
	);
	L.push(row("成本", `$${s.usage.cost.toFixed(3)}`));
	if (s.hints.length > 0) {
		L.push("");
		L.push(st.bold("效率提示"));
		for (const h of s.hints) L.push(`${st.fg("dim", "·")} ${h}`);
	}
	return L;
}

export default function elapsedStatus(pi: ExtensionAPI) {
	let sessionStart = Date.now();
	let turnStart = 0;
	let turnCount = 0;
	let activeMs = 0; // 已结束回合的 turn_start → turn_end 累计
	let modelMs = 0; // 已结束回合的「回合时长 − 工具耗时」累计
	let turnToolMs = 0; // 当前回合内的工具耗时（用于从回合时长里扣掉）
	let toolMs = 0;
	let toolCalls = 0;
	let toolFailed = 0;
	let turnOpen = false;
	/** 空闲开始时刻：会话开始 / 上一回合结束；下一个 turn_start 时结算成一次空闲区间。 */
	let idleSince = Date.now();
	let longestIdle = 0;
	let longestIdleAfterTurn = 0;
	let usage = emptyTokens();
	const byTool = new Map<string, { calls: number; ms: number }>();

	function reset(ctx: any) {
		sessionStart = Date.now();
		turnStart = 0;
		turnCount = 0;
		activeMs = 0;
		modelMs = 0;
		turnToolMs = 0;
		toolMs = 0;
		toolCalls = 0;
		toolFailed = 0;
		turnOpen = false;
		idleSince = sessionStart;
		longestIdle = 0;
		longestIdleAfterTurn = 0;
		byTool.clear();
		// 恢复历史会话时，tokens/成本从已有条目补齐（新回合再增量累加，不会重复）。
		usage = seedTokens(ctx?.sessionManager?.getEntries?.() ?? []);
	}

	function stats(): SessionStats {
		const now = Date.now();
		const openTurnMs = turnOpen && turnStart ? now - turnStart : 0;
		const wall = now - sessionStart;
		// 工具是单调时钟量的，可能比墙钟区间的下界更准（并行/边界误差），所以活跃至少不低于工具总时长。
		const active = Math.min(Math.max(activeMs + openTurnMs, toolMs), Math.max(wall, toolMs));
		const openModelMs = turnOpen && turnStart ? Math.max(0, openTurnMs - turnToolMs) : 0;
		const model = Math.max(0, Math.min(modelMs + openModelMs, active));
		const toolShare = active > 0 ? Math.min(1, toolMs / active) : 0;
		const idle = Math.max(0, wall - active);
		const activeRatio = wall > 0 ? Math.min(1, active / wall) : 0;

		const hints: string[] = [];
		if (wall > 60_000 && activeRatio < 0.2) {
			hints.push(`空闲占比偏高（${pct(idle / wall)}），大部分时间在等输入`);
		}
		const failRate = toolCalls > 0 ? toolFailed / toolCalls : 0;
		if (toolCalls >= 3 && failRate >= 0.2) {
			hints.push(`工具失败 ${toolFailed}/${toolCalls} 次，检查权限、路径或参数`);
		}
		if (active > 60_000 && activeRatio >= 0.2 && model / active >= 0.85) {
			hints.push("模型往返占活跃 85% 以上，慢在模型侧而非工具");
		}
		if (active > 60_000 && toolShare >= 0.5) {
			hints.push(`工具耗时占活跃 ${pct(toolShare)}，排查长耗时命令或改为单脚本并发探针`);
		}
		if (turnCount >= 25) {
			hints.push(`回合数偏高（${turnCount} 回合），检查是否微步串行或换强模型先定方案`);
		}
		if (active > 60_000 && toolShare >= 0.5) {
			hints.push(`工具耗时占活跃 ${pct(toolShare)}，排查长耗时命令或改为单脚本并发探针`);
		}
		if (turnCount >= 25) {
			hints.push(`回合数偏高（${turnCount} 回合），检查是否微步串行或换强模型先定方案`);
		}
		if (active > 60_000 && toolShare >= 0.5) {
			hints.push(`工具耗时占活跃 ${pct(toolShare)}，排查长耗时命令或改为单脚本并发探针`);
		}
		if (turnCount >= 25) {
			hints.push(`回合数偏高（${turnCount} 回合），检查是否微步串行或换强模型先定方案`);
		}
		if (active > 60_000 && toolShare >= 0.5) {
			hints.push(`工具耗时占活跃 ${pct(toolShare)}，排查长耗时命令或改为单脚本并发探针`);
		}
		if (turnCount >= 25) {
			hints.push(`回合数偏高（${turnCount} 回合），检查是否微步串行或换强模型先定方案`);
		}
		const avgActivePerTurn = turnCount > 0 ? active / turnCount : 0;
		if (turnCount >= 3 && avgActivePerTurn > 20_000) {
			hints.push(`单回合均 ${fmt(avgActivePerTurn)}，偏慢，考虑缩小上下文或换更快的模型`);
		}

		const top = [...byTool.entries()]
			.map(([name, v]) => ({ name, calls: v.calls, ms: v.ms }))
			.sort((a, b) => b.ms - a.ms || b.calls - a.calls)
			.slice(0, TOP_TOOLS);

		return {
			wall,
			active,
			idle,
			activeRatio,
			turns: turnCount,
			avgActivePerTurn,
			longestIdle,
			longestIdleAfterTurn,
			tools: {
				calls: toolCalls,
				ok: toolCalls - toolFailed,
				failed: toolFailed,
				ms: toolMs,
				avgMs: toolCalls > 0 ? toolMs / toolCalls : 0,
				shareOfActive: toolShare,
				top,
			},
			model: {
				totalMs: model,
				avgPerTurnMs: turnCount > 0 ? model / turnCount : 0,
				shareOfActive: active > 0 ? Math.min(1, model / active) : 0,
			},
			usage: { ...usage },
			hints,
		};
	}

	function styleOf(ctx: any): StyleLike {
		return ctx?.ui?.theme ?? PLAIN;
	}

	function paint(ctx: any) {
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus("elapsed", oneLine(stats(), styleOf(ctx)));
	}

	// 明细块走 custom entry：不参与 LLM 上下文、不花 token；行由渲染器用主题现场拼。
	pi.registerEntryRenderer("session-stats", (entry: any, _opts: any, theme: StyleLike) => {
		const data = entry?.data ?? {};
		const lines = data.json
			? [theme.fg("dim", "JSON"), ...String(data.json).split("\n")]
			: data.stats
				? cardLines(data.stats as SessionStats, theme)
				: ["(无数据)"];
		return { render: () => lines, invalidate: () => {} };
	});

	pi.on("session_start", async (_event, ctx) => {
		reset(ctx);
		paint(ctx);
	});

	pi.on("turn_start", async (event, ctx) => {
		const ts = (event as any)?.timestamp;
		turnStart = typeof ts === "number" ? ts : Date.now();
		// 结算一段空闲：会话开始 / 上一回合结束 → 本回合开始。
		const gap = turnStart - idleSince;
		if (gap > longestIdle) {
			longestIdle = gap;
			longestIdleAfterTurn = turnCount;
		}
		turnToolMs = 0;
		turnOpen = true;
		paint(ctx);
	});

	pi.on("tool_execution_end", async (event, _ctx) => {
		const e = event as any;
		const d = e?.durationMs;
		if (typeof d === "number" && Number.isFinite(d) && d > 0) {
			toolMs += d;
			turnToolMs += d;
		}
		toolCalls += 1;
		if (e?.isError) toolFailed += 1;
		const name = typeof e?.toolName === "string" ? e.toolName : "unknown";
		const prev = byTool.get(name) ?? { calls: 0, ms: 0 };
		prev.calls += 1;
		if (typeof d === "number" && Number.isFinite(d) && d > 0) prev.ms += d;
		byTool.set(name, prev);
	});

	pi.on("turn_end", async (event, ctx) => {
		const dur = turnOpen && turnStart ? Math.max(0, Date.now() - turnStart) : 0;
		activeMs += dur;
		modelMs += Math.max(0, dur - turnToolMs);
		turnToolMs = 0;
		turnOpen = false;
		turnCount += 1;
		const msg = (event as any)?.message;
		if (msg?.role === "assistant") addUsage(usage, msg.usage);
		idleSince = Date.now();
		paint(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		paint(ctx);
		// 页脚可能没渲染，这里再给一条一次性纯文本提示，保证总时长一定看得到。
		if (ctx?.hasUI) ctx.ui.notify(oneLine(stats(), PLAIN), "info");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx?.hasUI) ctx.ui.setStatus("elapsed", undefined);
	});

	const handler = async (args: string, ctx: any) => {
		const s = stats();
		const wantJson = /\bjson\b/i.test(args ?? "");
		if (!ctx?.hasUI) {
			const text = wantJson
				? JSON.stringify(s, null, 2)
				: cardLines(s, PLAIN).join("\n").replace(ANSI_RE, "");
			console.log(text);
			return;
		}
		pi.appendEntry("session-stats", wantJson ? { json: JSON.stringify(s, null, 2) } : { stats: s });
	};

	pi.registerCommand("stats", {
		description: "会话统计明细：时间拆分 / 工具成功率 / tokens 与成本 / 效率提示（--json 导出）",
		handler,
	});
	pi.registerCommand("elapsed", {
		description: "/stats 的别名",
		handler,
	});
}
