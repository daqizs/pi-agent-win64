/**
 * tool-hud.ts — 工具执行「单行精炼」显示（wb 简洁执行 / compact 轨迹 / detail 完整）
 *
 * 目标：
 *   1. 不再把每次工具调用的 参数 JSON + 输出正文 铺在对话里；
 *   2. wb（默认）= WorkBuddy 命令行那种简洁执行日志：
 *        ⊙ workbench.html +445 -0
 *        ⊙ canonical-schema.json +4 -1
 *        ⊙ src/app.ts
 *        ⊙ ls ~/Desktop
 *      行首一个统一的工具小圆点，不写动词、不报耗时；只有出错才换成 ✗。
 *   3. compact = Grok 轨迹风格：  ✓  ◎ path/to/file  ·  0.8s
 *      无序号、无工具名、无行数；耗时保留，失败才露完整 meta。
 *   4. detail 模式保留完整：  ✓ [03] bash  ▸  跑构建  ·  12 行  3.4s
 *   5. 出错时永远露出真实报错行 + 退出码，不会被吞掉；
 *   6. ctrl+o（或点击这一行）展开看完整参数与原始输出。
 *
 * 实现要点：
 *   - pi.registerToolRenderer((tool, next) => ...) 可以接管**所有**工具（内置 + MCP + 自定义），
 *     返回 next() 表示不接管。
 *   - renderShell: "self" 让我们自己画外壳，避免原生 Box 的背景块 + 上下 padding。
 *   - 关键技巧：返回的组件是「惰性」的 —— render() 时才去读 context.state，
 *     因为 updateDisplay 先调 renderCall、后调 renderResult，直接读会永远慢一帧。
 *   - ctrl+o 是**全局**开关（pi 的 setToolsExpanded 会把所有历史工具块一起展开），
 *     不是「只展开最后一行」。想只展开某一行请直接点它。
 *
 * 配置：~/.pi/agent/tool-hud.json
 *   mode            wb | compact | detail | hidden | off
 *                   wb     = WorkBuddy 简洁执行风格（默认）：图标 + 目标 + 增删行数
 *                   compact = Grok 轨迹风格：状态符 + 图标 + 目标 + 耗时
 *                   detail = 完整信息（序号、工具名、行数、耗时）
 *                   hidden = 成功的工具整行不显示，失败照样显示
 *                   off    = 完全回到 pi 原生渲染
 *   wbDuration      wb 模式下成功行是否也显示耗时（**默认关**，WorkBuddy 不显示）
 *   errorLines      失败时露几行报错（默认 3，优先挑带 error/TS1234/Traceback 的行）
 *   detailLines     detail 模式下露几行（默认 6）
 *   expandedMaxLines 展开时的行数上限（默认 4000，超出给「头 60% + 尾 40%」）
 *   trimOldResults  是否把很早的大输出替换成摘要（**默认关**；会改变发给模型的内容，属显式选择）
 *   keepRecentResults 保留最近几条大输出原文（默认 8）
 *   validateImages  拦截结构损坏的图片（默认开）
 *   thinkingLabel   「思考中」块的标题（**已失效**，见下方「改 pi 本体」；真文案由 PI_THINKING_LABEL 决定）
 *   enforceVerify   声称完成但没调 hud_verify 时，是否发提醒让模型补一轮（默认开，每轮最多一次）
 *   autoPatchPi     pi 升级后 dist/ 被覆盖时，session_start 自动重打显示补丁（默认开）
 *
 * 运行时切换：/hud wb | compact | detail | hidden | off | trim on|off | images on|off | reset
 * 自检脚本：~/.pi/agent/_dev/hud-harness.mjs（渲染用例）· hud-loadcheck.mjs（加载检查）
 *
 * 改 pi 本体（扩展钩子覆盖不到的三处）：
 *   ~/.pi/agent/_dev/patch-pi-hud.mjs   ← 幂等，apply / --revert / --check
 *     1. 工具块前面那个空行（ToolExecutionComponent 里写死 push("")）
 *     2. 思考块占位文案 "Thinking..." → "思考中…"（真正生效的是 InteractiveMode 的
 *        类字段 defaultHiddenThinkingLabel，不是 AssistantMessageComponent 的构造参数）
 *     3. 折叠思考的占位行改成「挂起」：后面没有可见内容（只有工具块）就不占行
 *   ⚠️ pi 有**两个构建产物**（dist/bundle 给命令行、dist/modes 给扩展 import），
 *      只改一个等于没改。`pi update` 会整体覆盖 dist/，本扩展会在下次 session_start
 *      自动重打（autoPatchPi），补丁本身要到再下一次启动才生效。
 *
 * 附带的 hud_verify 工具：
 *   工具只知道自己「跑完了」，不知道「目标达成没有」。hud_verify 让模型逐条声明
 *   已验证 / 未通过 / 待验证，渲染成一张验收卡（不是又一行日志）。
 *   - verified 必须带证据（跑过的命令、文件:行号、实测输出）
 *   - 靠推理得出的标 pending，别冒充 verified
 *   - 卡片宽度自适应（封顶 96 列），窄终端会截断并保持边框对齐
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, createBashToolDefinition, keyText } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import * as zlib from "node:zlib";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { looksLikeWrite } from "../lib/verify-gate-logic.mjs";

// 配置文件位置可用 PI_TOOL_HUD_CONFIG 覆盖（自检脚本靠它跑 /hud 而不污染真实配置）
const CONFIG_PATH = process.env.PI_TOOL_HUD_CONFIG?.trim() || join(homedir(), ".pi", "agent", "tool-hud.json");

type Mode = "wb" | "compact" | "detail" | "hidden" | "off";

type Status = "running" | "ok" | "empty" | "warn" | "partial" | "error";

const STATUS_GLYPH: Record<Status, string> = {
	running: "◐",
	ok: "✓",
	empty: "◇",
	warn: "!",
	partial: "◑",
	error: "✗",
};

/** 展开时先给一句结论（成功/失败/有警告…），再给原始输出 */
const STATUS_WORD: Record<Status, string> = {
	running: "执行中",
	ok: "成功",
	empty: "无结果",
	warn: "有警告",
	partial: "输出被截断",
	error: "失败",
};

const STATUS_COLOR: Record<Status, string> = {
	running: "warning",
	ok: "success",
	empty: "muted",
	warn: "warning",
	partial: "warning",
	error: "error",
};

/**
 * 只在「诊断形态」的行上判警告：行首带 warning/warn/deprecated/错误 这类标记，
 * 或者出现 file(line,col): error、TS1234 这种诊断码。
 *
 * 以前是全文任意位置命中 error/cannot/not found 就算警告，于是 `claude --help`
 * 这类「正文里提到错误」的成功输出、grep 出来的报错代码全被标成 !，
 * 状态符号也就不再表示任何东西了。
 */
const WARN_LINE_RE =
	/^\s*(?:[!⚠]|\[?(?:warn|warning|error|fatal)\]?\s*[:：]|(?:npm|yarn|pnpm)\s+WARN|deprecat\w*\s*[:：]|(?:警告|错误|失败)\s*[:：])|[\w./\\-]+\(\d+(?:,\d+)*\):\s*(?:error|warning)|\bTS\d{3,}\b/i;

/**
 * 失败时用来挑「真正该看的那几行」。
 * 失败输出里往往是开头一堆无关的横幅（npm 的 > build 之类），
 * 真正定位问题的是带 error/TS1234/Traceback 的行，所以折叠时优先显示这些。
 */
const ERROR_LINE_RE =
	/(\berror\b|\bfailed\b|\bfailure\b|\bfatal\b|\bcannot\b|\bunable\b|\bexception\b|traceback|no such file|not found|permission denied|\bTS\d{3,}\b|\bE[A-Z]{3,}\b|\b[A-Z]\w*(?:Error|Exception)\b|错误|失败|异常|无法|不存在)/i;

function statusOf(name: string, text: string, isError: boolean, isPartial: boolean): Status {
	if (isPartial) return "running";
	if (isError) return "error";
	const raw = shortToolName(name);
	const body = text.trim();
	// 内容型工具（read/grep/find/ls/glob）输出的是文件内容，里面出现 {"is_error":true} 不是工具报错
	if (!CONTENT_TOOLS.has(raw) && structuredError(body)) return "error";
	// 只对命令输出判警告；读文件/搜代码的内容里出现 error 是正常的
	if (raw === "bash" || raw === "powershell") {
		if (!body) return "ok"; // 静默成功（mkdir/rm 这类本来就无输出）
		return body.split("\n").some((line) => WARN_LINE_RE.test(line)) ? "warn" : "ok";
	}
	if (!body) return "empty";
	if (/^(no match|none|not found|0 results|empty)/i.test(body)) return "empty";
	return "ok";
}

// ---------------------------------------------------------------- 结果摘要 / 修复建议
// 「成功只占一行」的前提是那一行说得清结果，否则用户还得展开自己判断。
// 只做语法层面的摘要，不翻译也不推断语义：认得出结构化输出就给字段摘要，
// 认不出就取第一条有信息量的行，再不行老实退回「N 行输出」。

const SEPARATOR_RE = /^[-=_#*~·.\s]{3,}$/;
/** 命令回显 / 横幅这类「不是结果」的行 */
const BANNER_RE = /^(?:\$ |> |\+ |npm |yarn |added \d+ package)/;

/** 摘要优先看这些字段：先结论，后正文 */
const DIGEST_KEYS = [
	"ok",
	"success",
	"is_error",
	"status",
	"exit_code",
	"exitCode",
	"type",
	"subtype",
	"name",
	"version",
	"result",
	"message",
	"error",
];

function fieldsDigest(obj: Record<string, unknown>): string {
	const bits: string[] = [];
	for (const key of DIGEST_KEYS) {
		if (!(key in obj)) continue;
		const value = obj[key];
		if (value === undefined || value === null || value === "" || typeof value === "object") continue;
		bits.push(`${key}=${oneLine(String(value), 40)}`);
		if (bits.length >= 3) break;
	}
	return bits.length ? `json ${bits.join(" ")}` : `json ${Object.keys(obj).length} 键`;
}

/** JSON 对象 / NDJSON 事件流 → 短摘要；不是结构化输出就返回 undefined */
function jsonDigest(text: string): string | undefined {
	const body = text.trim();
	if (!/^[[{]/.test(body)) return undefined;
	try {
		const whole: unknown = JSON.parse(body);
		if (Array.isArray(whole)) return `json [${whole.length} 项]`;
		if (whole && typeof whole === "object") return fieldsDigest(whole as Record<string, unknown>);
	} catch {
		// 不是单个 JSON，下面按 NDJSON 再试
	}
	const lines = body
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length < 2) return undefined;
	const events: any[] = [];
	for (const lineText of lines.slice(0, 200)) {
		if (!lineText.startsWith("{")) return undefined;
		try {
			events.push(JSON.parse(lineText));
		} catch {
			return undefined;
		}
	}
	const types = [...new Set(events.map((e) => String(e?.type ?? e?.event ?? "")).filter(Boolean))];
	const bad = events.filter((e) => e?.is_error === true).length;
	const head = `jsonl ${events.length} 事件${types.length ? ` ${types.slice(0, 3).join("/")}` : ""}`;
	return bad ? `${head} · ${bad} 条 is_error` : head;
}

/** 结构化输出里写明 is_error: true 时，退出码 0 也不该显示成功 */
function structuredError(text: string): boolean {
	const body = text.trim();
	if (!body.startsWith("{")) return false;
	try {
		const whole: unknown = JSON.parse(body);
		return !!whole && typeof whole === "object" && (whole as { is_error?: unknown }).is_error === true;
	} catch {
		return false;
	}
}

/** 渲染每帧都会调一次，按 result 引用缓存（自动 GC，不把几百 KB 文本常驻当 Map key） */
const DIGEST_BY_REF = new WeakMap<object, string>();
const DIGEST_MEMO = new Map<string, string>();
const DIGEST_MEMO_MAX = 32;
const DIGEST_MEMO_MAX_KEY_LEN = 4096;

/** 一行结果摘要：结构化优先，其次命令的第一条有信息量的正文行 */
function digestOf(name: string, text: string, resultRef?: unknown): string | undefined {
	if (resultRef && typeof resultRef === "object") {
		const cached = DIGEST_BY_REF.get(resultRef);
		if (cached !== undefined) return cached || undefined;
		const body = text.trim();
		const value = body ? (computeDigest(name, body) ?? "") : "";
		DIGEST_BY_REF.set(resultRef, value);
		return value || undefined;
	}
	const body = text.trim();
	if (!body) return undefined;
	if (body.length > DIGEST_MEMO_MAX_KEY_LEN) {
		return computeDigest(name, body);
	}
	const key = `${name}\u0000${body}`;
	const memo = DIGEST_MEMO.get(key);
	if (memo !== undefined) return memo || undefined;
	const value = computeDigest(name, body) ?? "";
	DIGEST_MEMO.set(key, value);
	if (DIGEST_MEMO.size > DIGEST_MEMO_MAX) {
		const oldest = DIGEST_MEMO.keys().next();
		if (!oldest.done) DIGEST_MEMO.delete(oldest.value);
	}
	return value || undefined;
}

/** 这几个工具的输出是「文件内容」，JSON 是内容不是结论，不能拿它当摘要 */
const CONTENT_TOOLS = new Set(["read", "grep", "find", "ls", "glob"]);

function computeDigest(name: string, body: string): string | undefined {
	const raw = shortToolName(name);
	if (!CONTENT_TOOLS.has(raw)) {
		const structured = jsonDigest(body);
		if (structured) return structured;
	}
	if (raw !== "bash" && raw !== "powershell") return undefined;
	const lines = body
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !SEPARATOR_RE.test(l));
	const first = lines.find((l) => !BANNER_RE.test(l));
	return first ? oneLine(first, 48) : undefined;
}

/**
 * 已知失败模式的确定性猜测。只放高置信度的模式 —— 编一条错得理直气壮的猜测，
 * 比不给猜测更糟；认不出来就什么都不说。
 * 推辞一律写成名词短语（不加「可能」也不加祈使），句中只描述模式；
 * 「这是推测不是结论」由渲染时的「可能原因」标签统一承载，避免「可能原因可能是…」双重堆叠。
 */
const FIX_HINTS: Array<[RegExp, string]> = [
	[/(?:command not found|不是内部或外部命令|is not recognized as)/i, "命令不存在或不在 PATH 里（拼写 / 安装 / 路径）"],
	[/(?:Cannot find module|MODULE_NOT_FOUND)/i, "依赖未安装，或入口路径不对"],
	[/(?:ENOENT|no such file or directory|系统找不到指定的(?:文件|路径))/i, "路径不存在（文件名 / 大小写 / 当前目录）"],
	[/(?:EACCES|EPERM|permission denied|拒绝访问)/i, "权限不足（目录或运行身份）"],
	[/(?:EADDRINUSE|address already in use)/i, "端口已被占用"],
	[/(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|certificate|self.signed)/i, "地址 / 代理 / 证书有问题"],
	[/\bTS\d{3,}\b/, "TypeScript 类型错误（编号见原始输出）"],
	[/(?:\b401\b|\b403\b|unauthorized|invalid api key|not logged in)/i, "凭据或登录态失效"],
	[/(?:\b429\b|rate.?limit|quota exceeded)/i, "被限流或额度用尽"],
	[/(?:timed out|timeout)/i, "执行超时（任务粒度或 timeout）"],
	[/(?:SyntaxError|Unexpected token)/i, "语法错误"],
];

function fixHintOf(text: string): string | undefined {
	const flag = /requires?\s+(--?[a-z][\w-]+)/i.exec(text);
	if (flag) return `缺少 ${flag[1]} 参数`;
	for (const [re, hint] of FIX_HINTS) if (re.test(text)) return hint;
	return undefined;
}

interface HudConfig {
	mode: Mode;
	/** wb 模式下成功行是否也补耗时（默认关：WorkBuddy 的执行日志不显示单次耗时） */
	wbDuration: boolean;
	/** 成功行是否带一句结果摘要（结构化输出给字段摘要，其余给第一条有信息量的行） */
	resultDigest: boolean;
	/** 失败时给一条确定性修复建议（只认高置信度错误模式，认不出就不猜） */
	fixHint: boolean;
	/** 折叠状态下最多显示几行错误信息 */
	errorLines: number;
	/** detail 模式每步显示几行输出 */
	detailLines: number;
	/** 展开时的安全上限（超过就截断并提示，正常输出会完整显示） */
	expandedMaxLines: number;
	/** 上下文减负：把较旧的工具输出替换成占位符（默认关，会改变发给模型的内容） */
	trimOldResults: boolean;
	/** 保留最近多少条工具结果不动 */
	keepRecentResults: number;
	/** 工具返回的图片先本地校验，坏图直接丢掉，避免整轮请求被上游 400 */
	validateImages: boolean;
	/** 思考块的占位文案（pi 写死 Thinking...，这里用原型补丁换掉） */
	thinkingLabel: string;
	/** 声称完成却没调 hud_verify 时，是否额外发一条提醒让模型补验收（会多花一轮） */
	enforceVerify: boolean;
	/** pi 升级覆盖 dist/ 后，session_start 时自动重打显示补丁 */
	autoPatchPi: boolean;
}

const DEFAULTS: HudConfig = {
	mode: "wb",
	wbDuration: false,
	resultDigest: true,
	fixHint: true,
	errorLines: 3,
	detailLines: 6,
	expandedMaxLines: 4000,
	trimOldResults: false,
	keepRecentResults: 8,
	validateImages: true,
	thinkingLabel: "思考中…",
	enforceVerify: true,
	autoPatchPi: true,
};

function loadConfig(): HudConfig {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		return { ...DEFAULTS, ...raw };
	} catch {
		return { ...DEFAULTS };
	}
}

function saveConfig(cfg: HudConfig): void {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
	} catch {
		// 配置写不进去不影响本次运行
	}
}

// ---------------------------------------------------------------- 文本工具

function textOf(result: unknown): string {
	const content = (result as { content?: unknown })?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: "text"; text: string } => !!c && (c as { type?: string }).type === "text")
		.map((c) => c.text)
		.join("\n");
}

function oneLine(input: string, max = 80): string {
	const flat = input.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function relPath(input: string, cwd: string): string {
	if (!input) return "";
	let s = String(input).split("\\").join("/");
	const base = (cwd || "").split("\\").join("/").replace(/\/+$/, "");
	if (base && s.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return s.slice(base.length + 1);
	const home = homedir().split("\\").join("/").replace(/\/+$/, "");
	if (home && s.toLowerCase().startsWith(`${home.toLowerCase()}/`)) return `~${s.slice(home.length)}`;
	return s;
}

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function shortToolName(name: string): string {
	// mcp__server__tool → server:tool
	if (name.startsWith("mcp__")) {
		const parts = name.split("__");
		if (parts.length >= 3) return `${parts[1]}:${parts.slice(2).join("__")}`;
	}
	return name;
}

/** 同一命令/同一文件被重复调用时用来标「↳ 同 [02]」，只做保守的归一化 */
function repeatKey(name: string, args: Record<string, any>): string {
	const raw = shortToolName(name);
	if (raw === "bash" || raw === "powershell") {
		const cmd = String(args?.command ?? "")
			.replace(/\s+/g, " ")
			.replace(/^cd\s+\S+\s*&&\s*/, "")
			.trim();
		return cmd ? `sh:${cmd}` : "";
	}
	if (raw === "read") {
		const p = String(args?.path ?? "");
		return p ? `read:${p}` : "";
	}
	return "";
}

function firstStringArg(args: Record<string, unknown>): string {
	for (const value of Object.values(args ?? {})) {
		if (typeof value === "string" && value.trim()) return value;
	}
	return "";
}

// ---------------------------------------------------------------- 动作描述（图标 + 1 字动词，一眼能看懂）
// 颜色走 theme，不在这里硬编码，保证换主题一致。

/**
 * 动作标签：图标 + 短动词，一眼能看懂在做什么。
 * 单字符图标保持等宽；动词固定 1 字，避免再变回「读文件」那种长标签。
 */
const ACTION_ICON: Record<string, string> = {
	read: "◎ 读", // 读文件
	write: "▣ 写", // 写文件
	edit: "◈ 改", // 改文件
	search: "⌕ 搜", // 搜 / 搜代码
	view: "◉ 看", // 看（cat/head/tail 等）
	list: "☰ 列", // 列目录
	find: "⌕ 找", // 找文件
	run: "▸ 跑", // 执行 / 跑脚本
	web: "⌁ 网", // 联网
	memory: "◌ 记", // 记忆
	default: "·",
};

interface Action {
	/** 统一图标（优先）或短标签 */
	label: string;
	/** 作用对象 */
	target: string;
}

function tailToken(rest: string): string {
	const tokens = rest.split(/\s+/).filter((t) => t && !t.startsWith("-"));
	return tokens[tokens.length - 1] ?? "";
}

function looksLikePath(token: string): boolean {
	// 引号/正则符号说明这是 pattern，不是路径
	if (/["'|*?()[\]{}$^+<>]/.test(token)) return false;
	if (/^[a-zA-Z]:[\\/]/.test(token)) return true;
	if (token.includes("/") || token.includes("\\")) return true;
	return /\.(json|ts|tsx|js|mjs|cjs|py|md|txt|ya?ml|toml|log|csv|html|css|go|rs|java|sh|ps1)$/i.test(token);
}

function quotedPattern(rest: string): string {
	const quoted = /["']([^"']{1,80})["']/.exec(rest)?.[1];
	if (quoted) return `「${oneLine(quoted, 34)}」`;
	const token = rest.split(/\s+/).filter((t) => t && !t.startsWith("-") && !looksLikePath(t))[0];
	return token ? `「${oneLine(token, 34)}」` : "";
}

function inFile(rest: string): string {
	const token = rest.split(/\s+/).filter((t) => t && !t.startsWith("-")).find(looksLikePath);
	return token ? ` @ ${oneLine(token, 34)}` : "";
}

function gitLabel(rest: string): string {
	const sub = rest.split(/\s+/)[0] ?? "";
	const map: Record<string, string> = {
		status: "看改动状态",
		diff: "看差异",
		log: "看提交日志",
		add: "暂存改动",
		commit: "提交",
		checkout: "切分支",
		switch: "切分支",
		pull: "拉取",
		push: "推送",
		stash: "暂存现场",
		branch: "看分支",
		show: "看提交内容",
		blame: "追溯改动",
		remote: "看远端",
		fetch: "抓取远端",
		reset: "重置",
		restore: "还原文件",
	};
	return map[sub] ?? `git ${sub}`.trim();
}

function pkgLabel(base: string, rest: string): string {
	const parts = rest.split(/\s+/).filter(Boolean);
	const sub = parts[0] ?? "";
	if (["install", "i", "ci", "add"].includes(sub)) return "装依赖";
	if (sub === "run") return `跑 ${parts[1] ?? "脚本"}`;
	if (sub === "test" || sub === "t") return "跑测试";
	if (sub === "exec" || sub === "dlx") return "跑依赖里的命令";
	if (sub === "create" || sub === "init") return "初始化项目";
	return `${base} ${sub}`.trim();
}

function describeSegment(seg: string): string | undefined {
	const s = seg.replace(/^\s*(sudo|timeout\s+\S+|command)\s+/, "").trim();
	if (!s) return undefined;
	const first = s.split(/\s+/)[0] ?? "";
	const base = (first.split("/").pop() ?? first).replace(/\.exe$/i, "").toLowerCase();
	const rest = s.slice(first.length).trim();

	switch (base) {
		case "cd":
			return undefined;
		case "ls":
		case "dir":
		case "tree":
			return `${ACTION_ICON.list}${tailToken(rest) ? ` ${oneLine(tailToken(rest), 40)}` : ""}`;
		case "rg":
		case "grep":
		case "findstr":
			return `${ACTION_ICON.search}${quotedPattern(rest)}${inFile(rest)}`;
		case "fd":
		case "find":
			return `${ACTION_ICON.find}${quotedPattern(rest)}`;
		case "cat":
		case "head":
		case "tail":
		case "less":
		case "more":
			return `${ACTION_ICON.view} ${oneLine(tailToken(rest) || "文件", 40)}`;
		case "sed":
			return /-n\b/.test(rest) ? `${ACTION_ICON.view} ${oneLine(tailToken(rest), 40)}` : `${ACTION_ICON.edit} 文本`;
		case "git":
			return gitLabel(rest);
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun":
			return pkgLabel(base, rest);
		case "node":
		case "python":
		case "python3":
		case "tsx":
		case "deno":
			return `${ACTION_ICON.run} ${oneLine(tailToken(rest) || "脚本", 40)}`;
		case "curl":
		case "wget": {
			const url = /https?:\/\/[^\s"']+/.exec(rest)?.[0];
			let host = "";
			try {
				host = url ? new URL(url).host : "";
			} catch {
				host = "";
			}
			return `${ACTION_ICON.web} ${host || "URL"}`;
		}
		case "mkdir":
			return `建目录 ${oneLine(tailToken(rest), 40)}`.trim();
		case "rm":
			return `删除 ${oneLine(tailToken(rest), 40)}`.trim();
		case "mv":
			return `移动 ${oneLine(tailToken(rest), 40)}`.trim();
		case "cp":
			return `复制 ${oneLine(tailToken(rest), 40)}`.trim();
		case "echo":
		case "printf":
			return undefined;
		case "tasklist":
		case "ps":
			return `${ACTION_ICON.search} 进程`;
		case "wmic":
			return /process/i.test(rest) ? `${ACTION_ICON.search} 进程` : `${ACTION_ICON.run} wmic`;
		case "get-process":
		case "gps":
			return `${ACTION_ICON.search} 进程${rest ? ` ${oneLine(rest, 28)}` : ""}`;
		case "get-childitem":
		case "gci":
			return `${ACTION_ICON.list}${tailToken(rest) ? ` ${oneLine(tailToken(rest), 40)}` : ""}`;
		case "get-content":
		case "gc":
		case "type":
			return `${ACTION_ICON.view} ${oneLine(tailToken(rest) || "文件", 40)}`;
		case "select-string":
		case "sls":
			return `${ACTION_ICON.search}${quotedPattern(rest)}${inFile(rest)}`;
		case "set-content":
		case "out-file":
		case "add-content":
			return `${ACTION_ICON.write} ${oneLine(tailToken(rest) || "文件", 40)}`;
		case "copy-item":
		case "copy":
			return `复制 ${oneLine(tailToken(rest), 40)}`.trim();
		case "remove-item":
		case "ri":
		case "del":
			return `删除 ${oneLine(tailToken(rest), 40)}`.trim();
		case "move-item":
			return `移动 ${oneLine(tailToken(rest), 40)}`.trim();
		case "where":
		case "which":
		case "get-command":
			return `${ACTION_ICON.find} 命令`;
		case "du":
			return `${ACTION_ICON.view} 磁盘占用`;
		case "wc":
			return `${ACTION_ICON.view} 行数`;
		case "chmod":
			return `${ACTION_ICON.edit} 权限`;
		case "unzip":
		case "tar":
			return `${ACTION_ICON.run} 解压`;
		default:
			return undefined;
	}
}

/** 把一条 shell 命令翻成「做了什么」；认不出时给可读摘要，绝不返回空引号。 */
function describeShell(cmd: string): string {
	const raw = String(cmd ?? "").trim();
	if (!raw) return "（空命令）";
	const segs = raw
		.split(/&&|\|\||;|\n/)
		.map((s) => s.trim())
		.filter(Boolean);
	const labels: string[] = [];
	for (const seg of segs) {
		const label = describeSegment(seg);
		if (label && !labels.includes(label)) labels.push(label);
		if (labels.length >= 2) break;
	}
	if (labels.length) return labels.join(" + ");
	// 兜底：去掉 heredoc / 过长引号噪声，保留命令头
	const cleaned = raw
		.replace(/<<['"]?\w+['"]?[\s\S]*$/m, "…")
		.replace(/["']{2,}/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const brief = oneLine(cleaned || raw, 56);
	return brief && brief !== "\"" && brief !== "'" ? brief : oneLine(raw.split(/\s+/)[0] || "命令", 40);
}

function hostOf(url: string): string {
	try {
		return url ? new URL(url).host : "";
	} catch {
		return "";
	}
}

function actionOf(name: string, args: Record<string, any>, cwd: string): Action {
	const path = args?.path ?? args?.file_path ?? args?.filePath ?? args?.file ?? args?.dir ?? "";
	const raw = shortToolName(name);

	switch (raw) {
		case "bash":
		case "powershell":
			// shell 的 target 已含动作图标（搜/看/列目录…），label 用统一执行符
			return { label: ACTION_ICON.run, target: describeShell(String(args?.command ?? args?.script ?? "")) };
		case "read": {
			const range = args?.offset || args?.limit ? `:${args?.offset ?? 1}${args?.limit ? `+${args.limit}` : ""}` : "";
			return { label: ACTION_ICON.read, target: relPath(String(path), cwd) + range };
		}
		case "edit":
			return { label: ACTION_ICON.edit, target: relPath(String(path), cwd) };
		case "write":
			return { label: ACTION_ICON.write, target: relPath(String(path), cwd) };
		case "ls":
			return { label: ACTION_ICON.list, target: relPath(String(path || "."), cwd) };
		case "grep": {
			const p = String(args?.pattern ?? "");
			const where = path ? ` @ ${relPath(String(path), cwd)}` : "";
			return { label: ACTION_ICON.search, target: `「${oneLine(p, 34)}」${where}` };
		}
		case "find": {
			const p = String(args?.pattern ?? "");
			const where = path ? ` in ${relPath(String(path), cwd)}` : "";
			return { label: ACTION_ICON.find, target: `「${oneLine(p, 34)}」${where}` };
		}
		case "ast_grep": {
			const p = String(args?.pattern ?? "");
			const where = path ? ` @ ${relPath(String(path), cwd)}` : "";
			const lang = args?.lang ? ` (${args.lang})` : "";
			return { label: ACTION_ICON.search, target: `ast_grep 「${oneLine(p, 34)}」${lang}${where}` };
		}
		case "ast_edit": {
			const p = String(args?.pattern ?? "");
			const r = String(args?.rewrite ?? "");
			const tag = args?.dryRun === false ? "应用" : "预览";
			return { label: ACTION_ICON.edit, target: `ast_edit [${tag}] 「${oneLine(p, 26)}」 → 「${oneLine(r, 26)}」` };
		}
		case "web_search": {
			const list = Array.isArray(args?.queries) ? args.queries : [];
			const q = String(args?.query ?? list[0] ?? "");
			const many = list.length > 1 ? `（+${list.length - 1} 个查询）` : "";
			return { label: ACTION_ICON.web, target: `「${oneLine(q, 40)}」${many}` };
		}
		case "fetch_content": {
			const list = Array.isArray(args?.urls) ? args.urls : [];
			const url = String(args?.url ?? list[0] ?? "");
			const many = list.length > 1 ? `（${list.length} 个链接）` : "";
			return { label: ACTION_ICON.web, target: `${hostOf(url) || oneLine(url, 40)}${many}` };
		}
		case "get_search_content":
			return { label: ACTION_ICON.web, target: "" };
		case "memory_query_graph":
			return { label: ACTION_ICON.memory, target: oneLine(String(args?.entity ?? ""), 24) };
		case "memory_save_fact":
			return {
				label: ACTION_ICON.memory,
				target: `${oneLine(String(args?.subject ?? ""), 16)} · ${oneLine(String(args?.predicate ?? ""), 18)}`,
			};
		case "caveman_retrieve": {
			const handle = String(args?.recovery_handle ?? "").replace(/^ccr:\/\//, "");
			const q = args?.query ? `「${oneLine(String(args.query), 30)}」` : "";
			return { label: ACTION_ICON.memory, target: q || handle.slice(0, 16) };
		}
		case "codemode": {
			// 别把整段脚本（尤其内嵌 base64）铺在对话里
			const code = String(args?.code ?? "");
			const comment = /^\s*\/\/\s*(.+)$/m.exec(code)?.[1];
			if (comment) return { label: ACTION_ICON.run, target: oneLine(comment, 44) };
			const call = /tools\.([A-Za-z_][\w]*)\s*\(/.exec(code)?.[1];
			return { label: ACTION_ICON.run, target: call ? `调用 ${call}()` : "" };
		}
		default:
			return { label: ACTION_ICON.default, target: oneLine(firstStringArg(args ?? {}), 60) };
	}
}

// ---------------------------------------------------------------- 结果摘要

/**
 * pi 的 bash 工具在退出码非 0 时把状态拼在输出末尾，原文是
 *   "Command exited with code 2"
 * （见 dist/core/tools/bash.js：exitCode !== 0 → isError: true）
 * 所以红色 ✗ 的含义就是「进程退出码非 0」，不是"我猜它失败了"。
 */
/** pi 在 shell 工具失败时拼在正文末尾的那一行结论 */
const SHELL_STATUS_RE =
	/^(Command exited with code|Command timed out after|Command aborted|Command terminated without an exit code)/i;

function shellStatusOf(text: string): { code?: number; note?: string } {
	const exit = /Command exited with code (-?\d+)/i.exec(text) ?? /exit code:?\s*(-?\d+)/i.exec(text);
	if (exit) return { code: Number(exit[1]) };
	if (/Command timed out after/i.test(text)) return { note: "超时" };
	if (/Command aborted/i.test(text)) return { note: "已中止" };
	if (/Command terminated without an exit code/i.test(text)) return { note: "无退出码" };
	return {};
}

function diffStats(diff: unknown): { added: number; removed: number } | undefined {
	if (typeof diff !== "string") return undefined;
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

function summarize(
	name: string,
	args: Record<string, any>,
	result: any,
	isError: boolean,
	isPartial: boolean,
	durationMs: number | undefined,
	digest?: string,
): string {
	const raw = shortToolName(name);
	if (isPartial) return "执行中…";

	const bits: string[] = [];
	if (!result) return bits.join("  ");

	const text = textOf(result);
	const bodyLines = text ? text.split("\n").filter((l) => l.trim()).length : 0;
	const details = result.details ?? {};

	if (isError) {
		const shell = shellStatusOf(text);
		if (shell.code !== undefined) bits.push(`退出码 ${shell.code}`);
		else if (shell.note) bits.push(shell.note);
		else {
			const first = text.split("\n").find((l) => l.trim()) ?? "失败";
			bits.push(oneLine(first, 60));
		}
	} else {
		switch (raw) {
			case "edit": {
				const stats = diffStats(details.diff);
				bits.push(stats ? `+${stats.added}/-${stats.removed}` : "已应用");
				break;
			}
			case "write":
				bits.push(bodyLines ? `${bodyLines} 行` : "已写入");
				break;
			case "read":
				bits.push(bodyLines ? `${bodyLines} 行` : "空文件");
				break;
			case "grep":
				bits.push(bodyLines ? `${bodyLines} 条匹配` : "没匹配到");
				break;
			case "find":
				bits.push(bodyLines ? `${bodyLines} 个文件` : "没找到");
				break;
			case "ls":
				bits.push(bodyLines ? `${bodyLines} 项` : "空目录");
				break;
			case "bash":
			case "powershell":
				// 有摘要就先用摘要：只说「3 行输出」等于没说结果
				bits.push(digest ?? (bodyLines ? `${bodyLines} 行输出` : "无输出"));
				break;
			default:
				if (bodyLines) bits.push(`${bodyLines} 行`);
		}
		if (details?.truncation?.truncated) bits.push("已截断");
	}

	if (!isPartial && durationMs !== undefined && durationMs !== null) bits.push(fmtDuration(durationMs));
	return bits.join("  ");
}

// ---------------------------------------------------------------- wb 模式（WorkBuddy 简洁执行风格）
// WorkBuddy 的命令行执行日志不画图标、不标序号、不报耗时，一行只有「图标 + 目标」：
//   ⊙ workbench.html +445 -0           ← write
//   ⊙ canonical-schema.json +4 -1      ← edit
//   ⊙ src/app.ts                       ← read
//   ⊙ ls ~/Desktop/...                 ← bash
//   ⊙ 「TODO」 @ src                   ← grep
// 成功时用一个统一的「工具调用」小圆点 ⊙ 代替动词文字；
// 只有运行中 / 失败 / 警告才换成各自的符号 ◐ ✗ ! ◑，免得「简洁」把问题一起省掉。

/**
 * wb 模式的行首符号。成功 / 无结果用 ⊙（WorkBuddy 的统一小圆点，
 * 表示「这是一次工具调用」），其它状态用各自的符号。
 * 跟 STATUS_GLYPH 一样是单字符，颜色由 STATUS_COLOR 决定。
 */
const WB_GLYPH: Record<Status, string> = {
	running: "◐",
	ok: "⊙",
	empty: "⊙",
	warn: "!",
	partial: "◑",
	error: "✗",
};

/** 旧的 ACTION_ICON_RE 留下来，describeShell / actionOf 的其他调用方还在用 */
const ACTION_ICON_RE = /[◎▣◈⌕◉☰▸⌁◌·]\s*/g;

/**
 * 提取精简后的 shell 命令原文（去前导 cd ... && 和多余空白）。
 */
function wbShellCommand(args: Record<string, any>): string {
	return String(args?.command ?? args?.script ?? "")
		.replace(/\s+/g, " ")
		// 引号里的路径带空格（Windows 常见），\S+ 匹配不了，得单独认引号
		.replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/i, "")
		.trim();
}

function cleanArgFile(rest: string): string {
	const cleaned = rest
		.replace(/2>\s*\/dev\/null/gi, "")
		.replace(/\|.*$/, "")
		.replace(/>>?\s*\S+/g, "")
		.trim();
	const tokens = cleaned
		.split(/\s+/)
		.filter((t) => t && !t.startsWith("-") && !/^['"]$/.test(t));
	const last = tokens[tokens.length - 1] ?? "";
	return last.replace(/^['"]|['"]$/g, "");
}

function describeShellSegmentZh(seg: string): string | undefined {
	// 去掉前导环境变量赋值 / sudo / timeout / command
	const s = seg
		.replace(/^\s*(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, "")
		.replace(/^\s*(?:sudo|timeout\s+\S+|command)\s+/, "")
		.trim();
	if (!s) return undefined;

	// for 循环：按循环体核心动作概括
	if (/^for\s+\w+\s+in\b/i.test(s)) {
		if (/\bfd\b|\bfind\b/.test(s)) {
			const pat = /["']([^"']{1,30})["']/.exec(s)?.[1];
			return pat ? `遍历目录查找「${pat}」` : "遍历目录查找文件";
		}
		if (/\brg\b|\bgrep\b/.test(s)) {
			const pat = /["']([^"']{1,30})["']/.exec(s)?.[1];
			return pat ? `批量检索「${pat}」` : "批量检索文件内容";
		}
		if (/\bls\b|\bdir\b/.test(s)) return "遍历查看各目录内容";
		if (/\b-d\s+/.test(s)) return "检查各盘符目录是否存在";
		return "批量遍历执行检查";
	}

	// 写入脚本文件：cat > xxx.ps1 <<'PS'
	const heredocWrite = /^cat\s*>\s*([^\s<]+)\s*<</i.exec(s);
	if (heredocWrite) {
		return `创建临时脚本 ${oneLine(heredocWrite[1]!, 24)}`;
	}

	const first = s.split(/\s+/)[0] ?? "";
	const base = (first.split(/[\\/]/).pop() ?? first).replace(/\.exe$/i, "").toLowerCase();
	const rest = s.slice(first.length).trim();

	// 任意可执行文件带 --version / --help / /exit
	if (/^--?version\b/i.test(rest) || /\s--version\b/i.test(rest)) return `查看 ${base} 版本`;
	if (/^(--?help|help|\/\?)\b/i.test(rest)) return `查看 ${base} 帮助信息`;
	if (/^\/\/?exit\b/i.test(rest)) return `正常退出 ${base}`;

	switch (base) {
		case "cd":
		case "echo":
		case "printf":
		case "sleep":
			return undefined;
		case "ls":
		case "dir":
		case "tree":
		case "get-childitem":
		case "gci": {
			const target = cleanArgFile(rest);
			return target ? `列出 ${oneLine(target, 24)} 目录内容` : "列出当前目录内容";
		}
		case "cat":
		case "less":
		case "more":
		case "get-content":
		case "gc":
		case "type": {
			const target = cleanArgFile(rest);
			const headM = /\|\s*head\s+(?:-n\s*|-c\s*|-)(\d+)/.exec(s);
			const tailM = /\|\s*tail\s+(?:-n\s*|-)(\d+)/.exec(s);
			const name = target ? oneLine(target, 24) : "文件";
			if (headM) return `查看 ${name} 前 ${headM[1]} 行`;
			if (tailM) return `查看 ${name} 后 ${tailM[1]} 行`;
			return `查看 ${name} 内容`;
		}
		case "head": {
			const n = /(?:-n\s*|-c\s*|-)(\d+)/.exec(rest)?.[1];
			const unit = /-c\s*\d+/.test(rest) ? "字节" : "行";
			const target = cleanArgFile(rest.replace(/(?:-n|-c)\s*\d+|-\d+/g, ""));
			const name = target ? oneLine(target, 24) : "文件";
			return n ? `查看 ${name} 前 ${n} ${unit}` : `查看 ${name} 开头内容`;
		}
		case "tail": {
			const n = /(?:-n\s*|-)(\d+)/.exec(rest)?.[1];
			const target = cleanArgFile(rest.replace(/-n\s*\d+|-\d+/g, ""));
			const name = target ? oneLine(target, 24) : "文件";
			return n ? `查看 ${name} 末尾 ${n} 行` : `查看 ${name} 末尾内容`;
		}
		case "sed": {
			const range = /['"](\d+,\d+)p/.exec(rest)?.[1];
			const target = cleanArgFile(rest.replace(/['"][^'"]*['"]/g, ""));
			if (range) return `查看 ${target ? `${oneLine(target, 20)} ` : ""}第 ${range.replace(",", "–")} 行`;
			return /-n\b/.test(rest)
				? `提取 ${target ? oneLine(target, 22) : "文本"} 指定行`
				: `处理 ${target ? oneLine(target, 22) : "文本"} 内容`;
		}
		case "awk": {
			const range = /NR>=(\d+)\s*&&\s*NR<=(\d+)/.exec(rest);
			const target = cleanArgFile(rest.replace(/['"][^'"]*['"]/g, ""));
			if (range) return `提取 ${target ? `${oneLine(target, 20)} ` : ""}第 ${range[1]}–${range[2]} 行`;
			return `筛选并提取 ${target ? oneLine(target, 22) : "文本"} 内容`;
		}
		case "rg":
		case "grep":
		case "findstr":
		case "select-string":
		case "sls": {
			const pat = quotedPattern(rest);
			const file = inFile(rest).replace(/^ @ /, "");
			if (file && pat) return `在 ${oneLine(file, 20)} 中搜索${pat}`;
			if (pat) return `搜索${pat}`;
			return file ? `筛选 ${oneLine(file, 20)} 内容` : "搜索文本内容";
		}
		case "fd":
		case "find": {
			const pat = quotedPattern(rest);
			return pat ? `查找名称含${pat}的文件` : "查找匹配的文件";
		}
		case "ev": {
			const pat = quotedPattern(rest);
			return pat ? `全局快速搜索${pat}` : "全局快速搜索文件";
		}
		case "git":
			return `Git ${gitLabel(rest)}`;
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun":
			return pkgLabel(base, rest);
		case "node":
		case "tsx":
		case "deno": {
			if (/-e\b|<<|-\s*$/.test(rest)) {
				const jsonRef = /['"]([^'"\s]+\.json)['"]/.exec(s)?.[1];
				if (jsonRef && /writeFile/i.test(s)) return `用 Node 更新 ${oneLine(jsonRef, 20)}`;
				if (jsonRef) return `用 Node 读取并解析 ${oneLine(jsonRef, 20)}`;
				if (/readFile/i.test(s)) return "用 Node 扫描并分析文件内容";
				return "运行内联 Node 脚本";
			}
			const script = cleanArgFile(rest);
			return script ? `运行脚本 ${oneLine(script, 24)}` : "运行 Node 脚本";
		}
		case "python":
		case "python3": {
			if (/-c\b/.test(rest)) return "运行内联 Python 脚本";
			const script = cleanArgFile(rest);
			return script ? `运行 Python 脚本 ${oneLine(script, 22)}` : "运行 Python 脚本";
		}
		case "curl":
		case "wget": {
			const host = hostOf(/https?:\/\/[^\s"']+/.exec(rest)?.[0] ?? "");
			const isSave = /(?:^|\s)(?:-o|-O|--output)\b/.test(rest);
			if (isSave) return host ? `从 ${host} 下载文件` : "下载远程文件";
			if (host === "api.github.com") return "查询 GitHub API 信息";
			return host ? `请求 ${host} 获取数据` : "发起网络请求";
		}
		case "powershell":
		case "pwsh": {
			if (/Get-WinEvent/i.test(rest)) return "查询 Windows 系统事件日志";
			if (/Get-Process/i.test(rest)) return "查询运行中的进程";
			if (/Start-Process/i.test(rest)) return "启动外部程序";
			const psFile = /-File\s+["']?([^\s"']+)["']?/i.exec(rest)?.[1];
			if (psFile) return `执行 PowerShell 脚本 ${oneLine(psFile, 20)}`;
			return "执行 PowerShell 命令";
		}
		case "cmd": {
			if (/start\b/i.test(rest)) {
				const exe = /([^\\/"'\s]+\.exe)/i.exec(rest)?.[1];
				return exe ? `启动 ${oneLine(exe, 24)}` : "启动应用程序";
			}
			return "执行 Windows 命令";
		}
		case "tasklist":
		case "ps":
		case "get-process":
		case "gps": {
			const proc = /eq\s+([^\s"']+)/i.exec(rest)?.[1];
			return proc ? `检查进程 ${oneLine(proc, 22)} 状态` : "查询当前运行进程";
		}
		case "wmic":
			if (/logicaldisk/i.test(rest)) return "查看本机磁盘分区信息";
			return /process/i.test(rest) ? "查询系统进程信息" : "查询 Windows 系统信息";
		case "mkdir":
			return `创建目录 ${oneLine(cleanArgFile(rest), 24)}`.trim();
		case "rm":
		case "remove-item":
		case "ri":
		case "del":
			return `删除 ${oneLine(cleanArgFile(rest) || "文件", 24)}`;
		case "mv":
		case "move-item":
			return `移动或重命名 ${oneLine(cleanArgFile(rest) || "文件", 24)}`;
		case "cp":
		case "copy-item":
		case "copy":
			return `复制 ${oneLine(cleanArgFile(rest) || "文件", 24)}`;
		case "where":
		case "which":
		case "get-command": {
			const tool = cleanArgFile(rest);
			return tool ? `检查 ${oneLine(tool, 20)} 是否可用` : "检查命令路径";
		}
		case "wc":
			return `统计 ${oneLine(cleanArgFile(rest) || "输出", 20)} 行数`;
		case "du":
			return "查看磁盘占用大小";
		case "chmod":
			return "修改文件权限";
		case "unzip":
		case "tar":
			return "解压归档文件";
		default:
			return undefined;
	}
}

/**
 * 把一条 shell 命令翻译成清晰的中文一句话（模型未提供 description 时的兜底）。
 */
function describeShellZh(cmd: string): string {
	const raw = String(cmd ?? "").trim();
	if (!raw) return "执行空命令";
	const segs = raw
		.split(/&&|\|\||;|\n/)
		.map((s) => s.trim())
		.filter(Boolean);
	const parts: string[] = [];
	for (const seg of segs) {
		const zh = describeShellSegmentZh(seg);
		if (zh && !parts.includes(zh)) parts.push(zh);
		if (parts.length >= 2) break;
	}
	if (parts.length) return parts.join("并");
	const head = raw.split(/\s+/)[0]?.split(/[\\/]/).pop() ?? "命令";
	return `执行 ${oneLine(head, 24)}`;
}

/**
 * wb 模式下 shell 命令右侧的中文一句话注解：
 * 优先用模型主动填写的 description；漏填时用规则引擎翻成中文短句，绝不塞原始输出首行。
 */
function wbShellNote(name: string, args: Record<string, any>): string {
	const raw = shortToolName(name);
	if (raw !== "bash" && raw !== "powershell") return "";
	const desc = String(args?.description ?? "").trim();
	if (desc) return oneLine(desc, 48);
	const cmd = wbShellCommand(args);
	return cmd ? oneLine(describeShellZh(cmd), 48) : "";
}

/**
 * 作用对象。shell 左侧展示精简后的命令原文，右侧 `·` 后由 wbShellNote 给出中文一句话概括。
 */
function wbTarget(name: string, args: Record<string, any>, cwd: string): string {
	const raw = shortToolName(name);
	if (raw === "bash" || raw === "powershell") {
		const cmd = wbShellCommand(args);
		if (cmd) return oneLine(cmd, 60);
		const desc = String(args?.description ?? "").trim();
		if (desc) return oneLine(desc, 60);
	}
	// MCP 工具没有通用目标可推，光给第一个字符串参数会变成「⊙ pi」这种没头没尾的行，
	// 所以把工具名一起带上：⊙ github:search_repos 「pi」
	if (raw.includes(":")) {
		const arg = oneLine(firstStringArg(args ?? {}), 30);
		return arg ? `${raw} 「${arg}」` : raw;
	}
	const target = actionOf(name, args, cwd).target.replace(ACTION_ICON_RE, "").trim();
	// 推不出目标时退回工具名：一行只有一个光秃秃的圆点，等于什么都没说
	return target || shortToolName(name);
}

/**
 * 增删行数，WorkBuddy 的 +445 -0。
 * edit 的 details.diff 直接数；write 没有 diff，用要写进去的正文行数当新增行。
 */
function wbDiff(name: string, args: Record<string, any>, result: any): string {
	if (!result || result.isError) return "";
	const raw = shortToolName(name);
	if (raw === "edit") {
		const stats = diffStats(result?.details?.diff);
		return stats ? `+${stats.added} -${stats.removed}` : "";
	}
	if (raw === "write") {
		const body = String(args?.content ?? "");
		const added = body ? body.split("\n").length : 0;
		return added ? `+${added} -0` : "";
	}
	return "";
}

/**
 * footer 的「当前动作」：优先用模型写的中文 description，否则取最近一次调用的目标。
 */
function wbAct(name: string, args: Record<string, any>, cwd: string): string {
	const desc = String(args?.description ?? "").trim();
	if (desc) return oneLine(desc, 24);
	const target = wbTarget(name, args, cwd);
	const short = target.length > 24 ? target.split(/[\\/]/).pop() || target : target;
	return oneLine(short, 24);
}

/**
 * 内容型工具的结果摘要：read 报行数、grep 报命中数。正文本身不能当结论
 * （见 CONTENT_TOOLS），但这两个数字是从输出里数出来的事实，不是推断；
 * 输出被上限截断时只报「≥」，算不出来就不报 —— 宁可这行短，不许猜。
 */
function wbCount(name: string, result: any, text: string): string {
	if (!result || result.isError) return "";
	const body = String(text ?? "").trim();
	// caveman 之类的拦截层会把原始输出换成转存摘要（[SearchResult] + ccr:// 句柄），
	// 这时数行数、数命中数都是在数摘要本身，不能当结果报
	if (body.includes("ccr://") || /^\[SearchResult\]/i.test(body)) return "";
	const raw = shortToolName(name);
	if (raw === "read") {
		if (!body) return "空文件";
		const n = body.split("\n").length;
		return result?.details?.linesTruncated ? `≥${n} 行` : `${n} 行`;
	}
	if (raw === "grep") {
		if (!body || /^No matches found/i.test(body)) return "没命中";
		// grep 是「一处命中一行」，行数就是命中数；被上限截断时不敢报精确值
		const hits = body.split("\n").filter((l) => l.trim()).length;
		const capped = Boolean(result?.details?.matchLimitReached || result?.details?.linesTruncated);
		return capped ? `≥${hits} 处` : `命中 ${hits} 处`;
	}
	if (raw === "ast_grep") {
		const count = result?.details?.count;
		if (typeof count === "number") return count === 0 ? "没命中" : `命中 ${count} 处`;
	}
	if (raw === "ast_edit") {
		const count = result?.details?.count;
		if (typeof count === "number") {
			if (count === 0) return "没命中";
			return result?.details?.mode === "applied" ? `已改 ${count} 处` : `预计 ${count} 处`;
		}
	}
	return "";
}

/**
 * 画 wb 模式那一行：图标 + 目标（+ 增删行数 / 中文一句话注解）。
 */
function wbLine(o: {
	theme: Theme;
	status: Status;
	target: string;
	stats: string;
	durationMs: number | undefined;
	showDuration: boolean;
	width: number;
}): string {
	const mark = WB_GLYPH[o.status];
	const tailParts: string[] = [];
	if (o.stats) tailParts.push(o.stats);
	if (o.showDuration && o.durationMs !== undefined && o.durationMs !== null) {
		tailParts.push(fmtDuration(o.durationMs));
	}
	// WorkBuddy 的增删行数紧贴目标（⊙ file +445 -0）；文字注解需要分隔符，否则会被读成命令的一部分
	const sep = o.stats && !/^[+-]\d/.test(o.stats) ? "  ·  " : " ";
	const maxTailWidth = Math.max(16, Math.floor(o.width * 0.52));
	const rawTail = tailParts.join("  ");
	const tail = rawTail ? truncateToWidth(rawTail, maxTailWidth, "…") : "";
	const used = 2 + (tail ? visibleWidth(tail) + visibleWidth(sep) : 0) + 1;
	const target = o.target ? truncateToWidth(o.target, Math.max(12, o.width - used), "…") : "";

	let line = `${o.theme.fg(STATUS_COLOR[o.status], mark)} `;
	if (target) line += `${o.theme.fg("muted", target)}`;
	if (tail) line += `${sep}${o.theme.fg("dim", tail)}`;
	return line;
}

// ---------------------------------------------------------------- 惰性组件

/**
 * 每次 render 时才求值，避免 renderCall / renderResult 的调用顺序导致读到上一帧的状态。
 */
class LazyBlock implements Component {
	private readonly build: (width: number) => string[];

	constructor(build: (width: number) => string[]) {
		this.build = build;
	}

	render(width: number): string[] {
		let lines: string[];
		try {
			lines = this.build(width);
		} catch (e) {
			if (process.env.PI_HUD_DEBUG) console.error("[tool-hud] render 抛错：", e);
			lines = [];
		}
		if (!lines.length) return [];
		return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}

	invalidate(): void {
		// 无缓存，无需处理
	}
}

// ---------------------------------------------------------------- 验收卡
// 「工具调用成功」≠「任务成功」。工具只知道自己跑完了，不知道目标达成没有。
// 所以给模型一个显式声明的地方：hud_verify。它渲染成一张卡，而不是又一行日志。

type VerifyState = "verified" | "failed" | "pending" | "blocked";

const VERIFY_STYLE: Record<VerifyState | "claimed", { glyph: string; label: string; color: string }> = {
	verified: { glyph: "✓", label: "已验证", color: "success" },
	failed: { glyph: "✗", label: "未通过", color: "error" },
	pending: { glyph: "◇", label: "待验证", color: "warning" },
	blocked: { glyph: "⊘", label: "受限", color: "muted" },
	// 「模型说自己验证过，但拿不出证据」——不并入 verified，单独一档
	claimed: { glyph: "!", label: "仅声称", color: "warning" },
};

/** verified 但没写证据 → 只算声称，不算验证 */
function isClaimedOnly(item: VerifyItem): boolean {
	return item?.state === "verified" && !String(item?.evidence ?? "").trim();
}

interface VerifyItem {
	claim: string;
	state: VerifyState;
	evidence?: string;
}

/** 把一行内容补齐到 inner 列（先量宽再上色，避免 ANSI 影响边框对齐） */
function cell(text: string, inner: number): string {
	return truncateToWidth(text, Math.max(1, inner), "…", true);
}

function cardTop(title: string, width: number, theme: Theme): string {
	// 整行宽度 = ┌ + ─ + " title " + fill + ┐ = width
	const room = Math.max(4, width - 3);
	let t = ` ${title} `;
	if (visibleWidth(t) > room) t = truncateToWidth(t, room, "…");
	const fill = Math.max(0, room - visibleWidth(t));
	return theme.fg("borderMuted", "┌─") + theme.fg("toolTitle", t) + theme.fg("borderMuted", `${"─".repeat(fill)}┐`);
}

function cardBottom(summary: string, width: number, theme: Theme, color: string): string {
	const room = Math.max(4, width - 3);
	let s = ` ${summary} `;
	if (visibleWidth(s) > room) s = truncateToWidth(s, room, "…");
	const fill = Math.max(0, room - visibleWidth(s));
	return theme.fg("borderMuted", "└─") + theme.fg(color, s) + theme.fg("borderMuted", `${"─".repeat(fill)}┘`);
}

/**
 * 卡片里的一段内容。
 * - 不展开：压成一行，超宽用「…」截断（高度稳定，一屏能塞下更多卡）
 * - 展开：按可用列宽换行，**不丢尾部**，续行按 head 的显示宽度缩进
 * head 单独传进来，是为了让状态标签上色、而正文保持默认色，且缩进按列宽算（中文算 2 列）。
 */
function cardBlock(
	head: string,
	body: string,
	width: number,
	theme: Theme,
	opts: { color?: string; wrap?: boolean; dim?: boolean } = {},
): string[] {
	const inner = Math.max(4, width - 4);
	const bar = theme.fg("borderMuted", "│");
	const indent = " ".repeat(visibleWidth(head));
	const avail = Math.max(6, inner - visibleWidth(head));

	const rows: string[] = [];
	if (opts.wrap) {
		const parts = wrapTextWithAnsi(body, avail);
		for (const [i, p] of (parts.length ? parts : [""]).entries()) rows.push(i === 0 ? `${head}${p}` : `${indent}${p}`);
	} else {
		rows.push(`${head}${truncateToWidth(body, avail, "…")}`);
	}

	return rows.map((row) => {
		const padded = cell(row, inner);
		let painted = padded;
		if (opts.dim) painted = theme.fg("dim", padded);
		else if (opts.color && head && padded.startsWith(head)) painted = theme.fg(opts.color, head) + padded.slice(head.length);
		return `${bar} ${painted} ${bar}`;
	});
}

function renderVerifyCard(details: any, width: number, theme: Theme, running: boolean, expanded: boolean): string[] {
	const items: VerifyItem[] = Array.isArray(details?.items) ? details.items : [];
	const title = String(details?.title ?? "任务验收");
	const w = Math.max(24, Math.min(width, 96));
	const lines: string[] = [];

	// 标题行带总数：一眼知道这张卡有多少项，不用数行数
	const heading = items.length ? `${title} · ${items.length} 项` : title;
	lines.push(cardTop(heading, w, theme));

	if (!items.length) {
		lines.push(...cardBlock("", "（没有验收项）", w, theme, { dim: true }));
		lines.push(cardBottom(running ? "进行中…" : "无验收项", w, theme, "muted"));
		return lines;
	}

	for (const item of items) {
		const claimedOnly = isClaimedOnly(item);
		const style = claimedOnly ? VERIFY_STYLE.claimed : (VERIFY_STYLE[item.state] ?? VERIFY_STYLE.pending);
		const head = `${style.glyph} ${style.label}  `;
		const indent = " ".repeat(visibleWidth(head));

		lines.push(...cardBlock(head, String(item.claim ?? ""), w, theme, { color: style.color, wrap: true }));
		if (item.evidence) {
			// 证据是判断可信度的关键，折叠时也不要截断（真任务里已被截断过）
			lines.push(...cardBlock(indent, `证据：${String(item.evidence)}`, w, theme, { dim: true, wrap: true }));
		} else if (claimedOnly) {
			lines.push(...cardBlock(indent, "没有证据，只是声明 —— 未计入已验证", w, theme, { dim: true }));
		}
	}

	const n = (s: VerifyState) => items.filter((i) => i.state === s && !isClaimedOnly(i)).length;
	const claimedN = items.filter(isClaimedOnly).length;
	const parts: string[] = [];
	if (n("verified")) parts.push(`${n("verified")} 已验证`);
	if (claimedN) parts.push(`${claimedN} 仅声称`);
	if (n("failed")) parts.push(`${n("failed")} 未通过`);
	if (n("pending")) parts.push(`${n("pending")} 待验证`);
	if (n("blocked")) parts.push(`${n("blocked")} 受限`);
	const [verdict, tone] = n("failed")
		? ["✗ 未完成", "error"]
		: claimedN
			? ["! 有结论缺证据", "warning"]
			: n("verified") === 0
				? ["◇ 尚未验证", "warning"]
				: n("pending") || n("blocked")
					? ["◐ 部分未验证", "warning"]
					: ["✓ 全部通过", "success"];
	const summary = running ? "验收中…" : `${verdict}  ·  ${parts.join("  ·  ")}`;
	lines.push(cardBottom(summary, w, theme, running ? "muted" : tone));
	return lines;
}

// ---------------------------------------------------------------- 验收兜底
// 实测 deepseek-v4.1-flash 这类快模型：AGENTS.md 的硬规则它「知道」，
// 但真做任务时并不会自发调用 hud_verify。所以需要一个兜底检测：
// 本轮声称完成、却一次都没验收 → 提醒用户，必要时让模型补一轮。

const CLAIM_RE =
	/(改好了|修好了|已修好|已完成|完成了|已修复|修复完成|搞定|已实现|已添加|已更新|已删除|已改好|已经好了|没问题了|\bdone\b|\bfixed\b|\bimplemented\b|\bcompleted\b)/i;

function messageText(m: any): string {
	const c = m?.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.filter((p: any) => p?.type === "text")
		.map((p: any) => String(p.text ?? ""))
		.join("\n");
}

/** 本轮有没有「声称完成但没有验收声明」（只看最近一条 user 消息之后的当前轮） */
function claimsDoneWithoutVerify(messages: any[]): string | undefined {
	const full = Array.isArray(messages) ? messages : [];
	let start = 0;
	for (let i = full.length - 1; i >= 0; i--) {
		if (full[i]?.role === "user") {
			start = i + 1;
			break;
		}
	}
	const list = full.slice(start);
	const verifyCalled = list.some(
		(m) => m?.role === "assistant" && Array.isArray(m.content) && m.content.some((p: any) => p?.type === "toolCall" && p.name === "hud_verify"),
	);
	if (verifyCalled) return undefined;
	const hit = list.filter((m) => m?.role === "assistant").map(messageText).find((t) => t && CLAIM_RE.test(t));
	return hit;
}

// ---------------------------------------------------------------- 图片校验
// 模型偶尔会「手搓」base64 图片（比如 100x50 的 PNG，IDAT 是坏的）。
// 这种图一旦进了工具结果，上游会整轮 400 image_invalid，而且坏图留在历史里，
// 之后每一轮都失败。所以工具返回图片时先在本地验一遍，坏了就换成文字说明。

let crcTable: Uint32Array | undefined;

function crc32(buf: Buffer): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(buf: Buffer): string | undefined {
	if (buf.length < 16) return "PNG too short";
	if (buf[0] !== 0x89 || buf.toString("latin1", 1, 4) !== "PNG") return "bad PNG signature";
	let i = 8;
	let sawHeader = false;
	let sawEnd = false;
	const idat: Buffer[] = [];
	while (i + 12 <= buf.length) {
		const len = buf.readUInt32BE(i);
		const type = buf.toString("latin1", i + 4, i + 8);
		if (i + 12 + len > buf.length) return `truncated ${type} chunk`;
		const data = buf.subarray(i + 8, i + 8 + len);
		const stored = buf.readUInt32BE(i + 8 + len);
		if (crc32(Buffer.concat([Buffer.from(type, "latin1"), data])) !== stored) return `bad CRC in ${type}`;
		if (type === "IHDR") sawHeader = true;
		if (type === "IDAT") idat.push(data);
		if (type === "IEND") {
			sawEnd = true;
			break;
		}
		i += 12 + len;
	}
	if (!sawHeader) return "missing IHDR";
	if (!idat.length) return "missing IDAT";
	if (!sawEnd) return "missing IEND";
	try {
		zlib.inflateSync(Buffer.concat(idat));
	} catch {
		return "corrupt IDAT (zlib)";
	}
	return undefined;
}

function validateJpeg(buf: Buffer): string | undefined {
	if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return "missing JPEG SOI";
	let i = 2;
	let sawFrame = false;
	while (i + 4 <= buf.length) {
		if (buf[i] !== 0xff) {
			i++;
			continue;
		}
		const marker = buf[i + 1]!;
		if (marker === 0xd9) break;
		if (marker === 0xda) break; // start of scan：后面是熵编码数据
		if (marker >= 0xd0 && marker <= 0xd7) {
			i += 2;
			continue;
		}
		const len = buf.readUInt16BE(i + 2);
		if (len < 2 || i + 2 + len > buf.length) return "truncated JPEG segment";
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) sawFrame = true;
		i += 2 + len;
	}
	if (!sawFrame) return "missing JPEG frame header";
	const tail = buf.subarray(Math.max(0, buf.length - 64));
	if (!tail.includes(Buffer.from([0xff, 0xd9]))) return "missing JPEG EOI";
	return undefined;
}

function validateGif(buf: Buffer): string | undefined {
	if (buf.length < 7) return "GIF too short";
	const head = buf.toString("latin1", 0, 6);
	if (head !== "GIF87a" && head !== "GIF89a") return "bad GIF header";
	if (buf[buf.length - 1] !== 0x3b) return "missing GIF trailer";
	return undefined;
}

function validateWebp(buf: Buffer): string | undefined {
	if (buf.length < 12) return "WebP too short";
	if (buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") return "bad WebP header";
	if (buf.readUInt32LE(4) + 8 !== buf.length) return "WebP size mismatch";
	return undefined;
}

function imageProblem(mimeType: string, buf: Buffer): string | undefined {
	if (buf.length > 12 * 1024 * 1024) return undefined; // 大图不折腾，交给上游
	switch ((mimeType || "").toLowerCase()) {
		case "image/png":
			return validatePng(buf);
		case "image/jpeg":
		case "image/jpg":
			return validateJpeg(buf);
		case "image/gif":
			return validateGif(buf);
		case "image/webp":
			return validateWebp(buf);
		default:
			// 不认识格式就放行：pi 自己会把 bmp/avif 之类转成 PNG，
			// 转不了会退化成文字说明。这里拦下来等于凭白丢数据。
			return undefined;
	}
}

// ---------------------------------------------------------------- 思考占位文案
// pi 把 "Thinking..." 写死在 AssistantMessageComponent 里，ctx.ui 没有暴露入口，
// 只能给原型打补丁：每次 updateContent / setHiddenThinkingLabel 时把文案换掉。
//
// ⚠️ 2026-10-18 实测：这个补丁**大概率不生效**。
//   pi 的 bin 指向 dist/bundle/cli.js，那是 rollup 打的自包含产物，
//   里面有自己的 `AssistantMessageComponent=class` 和 `hiddenThinkingLabel="Thinking..."`。
//   而扩展 import 的是 dist/index.js（模块化构建），补丁打在**另一个类对象**上。
//   而且即使打在同一个类上也没用：InteractiveMode 每次构造都显式传 this.hiddenThinkingLabel，
//   真正决定文案的是 InteractiveMode 的类字段 defaultHiddenThinkingLabel。
//   → 已经改由 ~/.pi/agent/_dev/patch-pi-hud.mjs 直接改构建产物（bundle + modular 两处都改），
//     文案可用环境变量 PI_THINKING_LABEL 覆盖。这段原型补丁因此是**冗余**的，
//     保留着不删：无害，且万一 pi 以后不再写死文案，它也不会碍事。
// 失败就静默放弃，保持原生行为。

let thinkingLabel = DEFAULTS.thinkingLabel;
let thinkingPatched = false;

/** 展开工具输出的快捷键（pi 默认 ctrl+o），用于行尾提示 */
let expandKey = "ctrl+o";
try {
	expandKey = keyText("app.tools.expand") || expandKey;
} catch {
	// 拿不到就保持默认
}

function patchThinkingLabel(label: string): void {
	thinkingLabel = label;
	if (thinkingPatched) return;
	try {
		const proto = (AssistantMessageComponent as unknown as { prototype: Record<string, any> }).prototype;
		const originalUpdate = proto.updateContent;
		const originalSet = proto.setHiddenThinkingLabel;
		if (typeof originalUpdate !== "function") return;

		proto.updateContent = function (this: any, ...args: any[]) {
			this.hiddenThinkingLabel = thinkingLabel;
			return originalUpdate.apply(this, args);
		};
		if (typeof originalSet === "function") {
			proto.setHiddenThinkingLabel = function (this: any) {
				this.hiddenThinkingLabel = thinkingLabel;
			};
		}
		thinkingPatched = true;
	} catch {
		// 补丁失败就保持 pi 原生文案
	}
}

// ---------------------------------------------------------------- pi 本体补丁自愈
// `pi update` 会把 install/releases/<ver>/ 整个换掉，dist/ 里的两处改动随之消失：
//   1. 工具块前的空行（会退回到「每次调用前面空一行」）
//   2. 思考块文案（退回 "Thinking..."）
// 这两个位置 pi 没有暴露任何钩子，只能改构建产物，所以补丁只能活在 dist 里，
// 每次升级必然丢。这里在 session_start 做一次自检 + 自动重打：
//   - 只在明确「原始状态」时才动手；PASS 零成本跳过；ERROR（查不成）必须显式报，不能静默
//   - --check --json 给三态：pass / needs_action / error，只有 pass 才算补丁验收成功
//   - 子进程用 process.execPath（pi 自己就是 node，不用猜 node 在哪）
//   - 补丁改的是磁盘文件，**本次进程已经 import 过了**，所以要下次启动才生效，提示里写清楚
//   - 失败不抛异常，只 notify，绝不因为补丁问题影响正常会话

const PI_PATCH_SCRIPT = join(homedir(), ".pi", "agent", "_dev", "patch-pi-hud.mjs");

function runPatchScript(args: string[], timeout: number): Promise<{ ok: boolean; out: string; stdout: string }> {
	return new Promise((resolve) => {
		execFile(process.execPath, [PI_PATCH_SCRIPT, ...args], { timeout }, (err, stdout, stderr) => {
			resolve({ ok: !err, out: `${stdout ?? ""}${stderr ?? ""}`, stdout: String(stdout ?? "") });
		});
	});
}

/** 返回 true 表示这次真的重打了补丁（调用方负责提示） */
async function ensurePiPatch(ctx: any, enabled: boolean): Promise<boolean> {
	if (!enabled) return false;
	const notify = (msg: string, level: string) => {
		try {
			ctx?.ui?.notify?.(msg, level);
		} catch {
			// UI 还没就绪就放弃提示，不影响补丁本身
		}
	};
	if (!existsSync(PI_PATCH_SCRIPT)) {
		notify("找不到 pi 显示补丁脚本 _dev/patch-pi-hud.mjs，autoPatchPi 无法自检", "warning");
		return false;
	}
	const check = await runPatchScript(["--check", "--json"], 15000);
	let report: any;
	try {
		report = JSON.parse(check.stdout.trim());
	} catch {
		// 查不成 ≠ 不需要处理：这里必须报，否则升级后补丁没适配也看不出来
		notify("pi 显示补丁检查失败（脚本没返回可解析结果），请手动跑 _dev/patch-pi-hud.mjs --check", "error");
		return false;
	}
	if (report?.status === "pass") return false;
	if (report?.status === "error") {
		notify(`pi 显示补丁检查未能完成：${report.reason ?? "原因未知"}（手动跑 _dev/patch-pi-hud.mjs --check）`, "error");
		return false;
	}
	const patches = Array.isArray(report?.patches) ? report.patches : [];
	// 只有全部处于「原始状态」才可以安全自动重打；半新半旧硬改会写坏文件
	const allOriginal = patches.length > 0 && patches.every((p: any) => p?.state === "original");
	if (!allOriginal) {
		notify("pi 显示补丁处于半新半旧状态（或含无法自动处理项），不能自动重打，请手动跑 _dev/patch-pi-hud.mjs --check", "warning");
		return false;
	}
	const apply = await runPatchScript([], 20000);
	if (!apply.ok) {
		notify("pi 升级覆盖了 dist/，显示补丁自动重打失败，请手动跑 _dev/patch-pi-hud.mjs", "error");
		return false;
	}
	notify("pi 升级覆盖了 dist/，显示补丁已自动重打（重启 pi 后生效）", "info");
	return true;
}

// ---------------------------------------------------------------- 四层结构
// pi 的 transcript 是一条条追加的，扩展只能决定「每一条长什么样」，不能重排历史。
// 所以层级不是靠缩进堆出来的，而是各层各用一个渲染槽位：
//   L1 任务级  ui.setStatus 固定槽位：任务标识 + 当前阶段 + 计数，一行原地更新，永不追加
//   L2 执行级  消息区只给「每次调用一行」，不打阶段标题（事后分组会归错段，见 F1）
//   L3 异常级  失败独立成卡：标题 + 原因 + 建议 + 原始输出
//   L4 结果级  agent_end 落一条 custom entry：执行 / 恢复 / 验收 分开报
// 反过来的错误做法是把每条调用都包成卡 —— 边框和标题会把输出搞得更密。

interface VerifyTally {
	verified: number;
	claimed?: number;
	failed: number;
	pending: number;
	blocked: number;
}

/** 本轮的执行统计：L1 状态行和 L4 结束卡片共用同一份数据 */
interface TurnTally {
	ops: number;
	ok: number;
	failed: number;
	modFiles: Set<string>;
	mutated: boolean;
	verify?: VerifyTally;
	/** 最近一次失败当时的成功数：之后成功数变多 = 已恢复 */
	okAtLastFail: number;
	/** 最近一次成功调用的短标签，用来说清「后来的什么检查通过了」 */
	lastOkLabel?: string;
	/** 任务标识只从真数据来（hud_verify 的 title），没有就用固定标识，不编 */
	taskLabel?: string;
	startedAt: number;
}

function newTurn(): TurnTally {
	return { ops: 0, ok: 0, failed: 0, modFiles: new Set(), mutated: false, okAtLastFail: 0, startedAt: 0 };
}

/** 写进 transcript 的 L4 卡片数据（纯 JSON，不依赖渲染时的闭包状态） */
interface TaskSummary {
	ops: number;
	ok: number;
	failed: number;
	modFiles: string[];
	mutated: boolean;
	verify?: VerifyTally;
	/** 失败之后还有成功调用 = 恢复过；不等于失败被修好，更不等于验收通过 */
	recovered: boolean;
	lastOkLabel?: string;
	durationMs: number;
}

function pathOfInput(args: Record<string, any>): string | undefined {
	const raw = args?.file_path ?? args?.path ?? args?.filePath ?? args?.target_file ?? args?.file;
	return typeof raw === "string" && raw ? raw : undefined;
}

/**
 * 复用 lib/verify-gate-logic.mjs 的统一写入识别规则（带去引号/heredoc 保护与 PowerShell/POSIX 全量写入表），
 * 保证 tool-hud 与 enforce-verify-gate 的只读/写入判定完全一致。
 */
function isMutatingShell(cmd: string): boolean {
	return looksLikeWrite("bash", { command: cmd });
}

/** 纯只读：没改文件、也没在 shell 里写过东西 */
function isReadonlyTurn(data: TaskSummary): boolean {
	return data.modFiles.length === 0 && !data.mutated;
}

function tallyVerify(args: Record<string, any>): TurnTally["verify"] {
	const items = Array.isArray(args?.items) ? args.items : [];
	const out = { verified: 0, claimed: 0, failed: 0, pending: 0, blocked: 0 };
	for (const item of items) {
		if (isClaimedOnly(item)) {
			out.claimed += 1;
			continue;
		}
		const state = String(item?.state ?? "pending");
		if (state === "verified") out.verified += 1;
		else if (state === "failed") out.failed += 1;
		else if (state === "blocked") out.blocked += 1;
		else out.pending += 1;
	}
	return out;
}

/**
 * 任务结论。agent_end 只能证明「这一轮对话结束了」，不是验收通过。
 * 所以三件事分开说：执行结果（卡内统计行）、恢复情况（恢复行）、验收状态（验收行）。
 * 不许用一个「任务结束（有失败）」把三种情况揉成一句。
 */
function taskVerdict(data: TaskSummary): { title: string; bottom: string; tone: string } {
	const v = data.verify;
	const claimed = v?.claimed ?? 0;
	// 标题说「发生了什么」，卡底说「验收到哪一步」，两句话不重复
	if (v && v.verified > 0 && claimed === 0 && v.failed === 0 && v.pending === 0 && v.blocked === 0) {
		return { title: "✓ 验收通过", bottom: "全部项已验证", tone: "success" };
	}
	if (v && v.failed > 0) return { title: "! 验收未通过", bottom: "有未通过项", tone: "warning" };
	if (v && claimed > 0) return { title: "! 有结论缺证据", bottom: "有未附证据的声称", tone: "warning" };
	if (v && (v.pending > 0 || v.blocked > 0)) return { title: "! 验收未完成", bottom: "有未完成项", tone: "warning" };
	// 没验收证据：可以说「检查通过」，但不能说「已验收」
	if (data.failed === 0) {
		// 有改动却没声明验收 = 失职，必须留警告，不能静默过去
		if (!isReadonlyTurn(data)) return { title: "! 未经验收的变更", bottom: "有修改，未声明验收", tone: "warning" };
		return { title: "─ 检查通过", bottom: "尚未验收", tone: "muted" };
	}
	if (data.recovered) return { title: "─ 失败后已恢复", bottom: "尚未验收", tone: "muted" };
	return { title: "! 有失败", bottom: "尚未验收", tone: "warning" };
}

function renderTaskCard(data: TaskSummary, width: number, theme: Theme, expanded: boolean): string[] {
	const w = Math.max(24, Math.min(width, 96));
	const verdict = taskVerdict(data);
	const lines: string[] = [cardTop(verdict.title, w, theme)];
	// 执行结果
	const stat = [`${data.ops} 项`, `成功 ${data.ok}`, ...(data.failed ? [`失败 ${data.failed}`] : [])].join(" · ");
	lines.push(...cardBlock("执行  ", stat, w, theme));
	// 恢复情况：只说事实（后续还有调用成功），不说「已修好」
	if (data.failed > 0) {
		const what = data.lastOkLabel ? `后续「${data.lastOkLabel}」通过` : "后续仍有调用通过";
		lines.push(...cardBlock("恢复  ", data.recovered ? what : "失败后没有新的成功调用", w, theme));
	}
	if (data.modFiles.length) {
		const room = expanded ? 20 : 4;
		const shown = data.modFiles.slice(0, room).join("  ");
		const more = data.modFiles.length > room ? `  等 ${data.modFiles.length} 个文件（展开查看）` : "";
		lines.push(...cardBlock("修改  ", shown + more, w, theme, { wrap: expanded }));
	} else if (data.mutated) {
		lines.push(...cardBlock("修改  ", "shell 里有写入动作", w, theme, { dim: true }));
	}
	// 验收状态：没证据就写没证据，不靠「全部成功」冒充
	if (data.verify) {
		const v = data.verify;
		const bits = [`已验证 ${v.verified}`];
		if (v.claimed) bits.push(`仅声称 ${v.claimed}`);
		if (v.failed) bits.push(`未通过 ${v.failed}`);
		if (v.pending) bits.push(`待验证 ${v.pending}`);
		if (v.blocked) bits.push(`受限 ${v.blocked}`);
		lines.push(...cardBlock("验收  ", bits.join(" · "), w, theme, { color: v.failed || v.claimed ? "warning" : undefined }));
	} else {
		lines.push(...cardBlock("验收  ", "尚无完整验收证据", w, theme, { dim: true }));
	}
	lines.push(...cardBlock("耗时  ", fmtDuration(data.durationMs), w, theme, { dim: true }));
	lines.push(cardBottom(verdict.bottom, w, theme, verdict.tone));
	return lines;
}

// ---------------------------------------------------------------- 扩展本体

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	let mode: Mode = config.mode;
	/** 本轮调用的序号，每次 agent_start 归零 */
	let seqCounter = 0;
	/** 本轮见过的命令/文件 → 首次出现的序号，用来标重复调用 */
	const repeatSeen = new Map<string, number>();
	/** L1/L4 共用的本轮统计 */
	let turn = newTurn();
	/** 最近一次拿到的扩展上下文（工具渲染器拿不到 ctx，只能从 hook 里接） */
	let latestCtx: any;

	patchThinkingLabel(config.thinkingLabel);

	pi.on("agent_start", () => {
		seqCounter = 0;
		repeatSeen.clear();
		turn = newTurn();
	});
	pi.on("session_start", (_event: any, ctx: any) => {
		seqCounter = 0;
		repeatSeen.clear();
		turn = newTurn();
		latestCtx = ctx;
		// 升级后 dist/ 被覆盖 → 自动重打显示补丁（异步、不阻塞、失败不抛）
		void ensurePiPatch(ctx, config.autoPatchPi).catch(() => {});
	});

	// 验收兜底：声称完成但本轮没验收 → 提醒（可选让模型补一轮）
	/** 每次「用户发起的新一轮」才重置，避免提醒自己触发自己导致死循环 */
	let remindedThisRun = false;
	pi.on("before_agent_start", (event: any) => {
		if (event?.messageType === "user") remindedThisRun = false;
	});
	pi.on("agent_end", (event: any, ctx: any) => {
		if (mode === "off") return;
		latestCtx = ctx ?? latestCtx;
		const readonlyToolTurn = turn.ops > 0 && turn.modFiles.size === 0 && !turn.mutated;
		// L4：收尾卡片 + 清掉 L1 的 footer 状态（不管后面验不验收，本轮统计都要落）
		flushTask(ctx);
		// 纯只读工具查询回合（读文件/搜索/列目录，无任何写入）不触发「声称完成却没验收」误报
		if (readonlyToolTurn) return;
		const claim = claimsDoneWithoutVerify(event?.messages ?? []);
		if (!claim) return;
		const excerpt = oneLine(claim.replace(/\s+/g, " ").trim(), 60);
		ctx.ui.notify(`⚠ 声称完成但本轮没有 hud_verify 验收声明：${excerpt}`, "warning");
		// 如果 enforce-verify-gate 在本轮已经拦过一次（注入过 verify-gate），不再重复补发第二轮
		const alreadyNudgedByGate =
			Array.isArray(event?.messages) &&
			event.messages.some((m: any) => m?.customType === "verify-gate");
		if (!config.enforceVerify || remindedThisRun || alreadyNudgedByGate) return;
		remindedThisRun = true;
		try {
			pi.sendMessage(
				{
					customType: "hud_verify_reminder",
					display: false,
					content:
						"你刚才在回复里声称完成，但本轮没有调用 hud_verify。现在补上：逐条写 claim + state" +
						"（verified 必须附证据：命令/文件:行号/实测值；靠推理的标 pending；实测不符的标 failed）。" +
						"不要再改代码，只补验收声明。",
				},
				{ triggerTurn: true },
			);
		} catch {
			// 发送失败就算了，不能因为兜底提醒把会话搞崩
		}
	});

	pi.registerCommand("hud", {
		description: "工具显示模式：wb | compact | detail | hidden | off | trim on/off | images on/off | verify on/off | reset",
		handler: async (arg, ctx) => {
			const parts = String(arg ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
			const head = parts[0];

			if (head === "wb" || head === "compact" || head === "detail" || head === "hidden" || head === "off") {
				mode = head;
				config = { ...config, mode };
				saveConfig(config);
				ctx.ui.notify(`tool-hud: ${mode}（新的工具调用生效）`, "info");
				return;
			}
			if (head === "trim") {
				const on = parts[1] !== "off";
				config = { ...config, trimOldResults: on };
				saveConfig(config);
				ctx.ui.notify(`tool-hud: 上下文减负 ${on ? "已开启" : "已关闭"}`, "info");
				return;
			}
			if (head === "images") {
				const on = parts[1] !== "off";
				config = { ...config, validateImages: on };
				saveConfig(config);
				ctx.ui.notify(`tool-hud: 坏图拦截 ${on ? "已开启" : "已关闭"}`, "info");
				return;
			}
			if (head === "duration") {
				const on = parts[1] !== "off";
				config = { ...config, wbDuration: on };
				saveConfig(config);
				ctx.ui.notify(`tool-hud: wb 模式耗时${on ? "已显示" : "已隐藏"}`, "info");
				return;
			}
			if (head === "verify") {
				const on = parts[1] !== "off";
				config = { ...config, enforceVerify: on };
				saveConfig(config);
				ctx.ui.notify(`tool-hud: 验收兜底提醒 ${on ? "已开启" : "已关闭"}`, "info");
				return;
			}
			if (head === "reset") {
				config = { ...DEFAULTS };
				mode = config.mode;
				saveConfig(config);
				ctx.ui.notify("tool-hud: 已恢复默认（wb）", "info");
				return;
			}

			let key = "ctrl+o";
			try {
				key = keyText("app.tools.expand") || key;
			} catch {
				// 拿不到就用默认提示
			}
			ctx.ui.notify(
				`tool-hud 当前：${mode} · 展开：${key}\n用法：/hud wb | compact | detail | hidden | off | trim on|off | images on|off | duration on|off | verify on|off | reset\n验收卡：让模型调用 hud_verify（已验证 / 未通过 / 待验证）`,
				"info",
			);
		},
	});

	// ------------------------------------------------------------ 验收卡工具
	// 工具只知道自己「跑完了」，不知道「目标达成没有」。这个工具让模型显式表态。
	// 用 enum 而不是 Type.Union([Literal…])：后者会生成 anyOf+const，
	// pi 自带的工具 schema 里一个 anyOf 都没有，说明这条路上踩过坑。
	const VERIFY_STATE_SCHEMA = Type.Unsafe<VerifyState>({
		type: "string",
		enum: ["verified", "failed", "pending", "blocked"],
		description:
			"verified=已验证通过（必须带证据）/ failed=验证不通过 / pending=尚未验证 / blocked=外部条件不允许验证；pending 与 blocked 都不算通过",
	});

	const VERIFY_ITEM_SCHEMA = Type.Object({
		claim: Type.String({ description: "要验收的结论，一句话，写成可判真假的陈述" }),
		state: VERIFY_STATE_SCHEMA,
		evidence: Type.Optional(
			Type.String({ description: "证据：跑过的命令、文件:行号、实测输出摘要。verified 必须给" }),
		),
	});

	pi.registerTool({
		name: "hud_verify",
		label: "验收声明",
		description:
			"声明本轮任务逐条的验收状态（已验证 / 未通过 / 待验证 / 受限），在对话里渲染成一张验收卡。" +
			"在回复里写下「改好了 / 修好了 / 完成了 / 没问题」这类结论之前先调用它 —— 工具跑完不等于目标达成。",
		promptSnippet:
			"Declare per-item verification status before claiming a task is done (renders a verification card)",
		promptGuidelines: [
			"每当你要在回复里写下「改好了 / 修好了 / 完成了 / 已验证 / 没问题 / 应该可以」这类结论之前，先调用 hud_verify 声明状态。这条优先于其它收尾习惯。",
			"只有真正跑过、看过输出的结论才标 verified，并写证据（命令、文件:行号、实测值）；靠推理或读代码得出的标 pending；实测不符合预期标 failed 并写清「期望 X，实际 Y」。",
			"外部条件不允许验证（需要用户确认、缺凭据、依赖不可达）标 blocked —— pending 与 blocked 都不算通过，全 pending 的卡不能作为完成依据。",
			"不要用它复述计划或待办，只写已经能判定的结论；claim 写成给人看的陈述句，不要写变量名。",
			"纯问答、查资料、读文件回答问题这类没有「完成/未完成」的任务，不用调用。",
		],
		parameters: Type.Object({
			title: Type.Optional(Type.String({ description: "任务名，例如「修复 Ctrl+B 快捷键冲突」" })),
			items: Type.Array(VERIFY_ITEM_SCHEMA, { description: "逐条验收项，一条一个可判定的结论" }),
		}),
		async execute(_toolCallId, params) {
			const items = (params.items ?? []) as VerifyItem[];
			const title = params.title?.trim() || "任务验收";
			const evid = (s: VerifyState) => items.filter((i) => i.state === s && !isClaimedOnly(i)).length;
			const claimed = items.filter(isClaimedOnly).length;
			const counts = [`${evid("verified")} 已验证`];
			if (claimed) counts.push(`${claimed} 仅声称（缺证据）`);
			counts.push(`${evid("failed")} 未通过`, `${evid("pending")} 待验证`);
			if (evid("blocked")) counts.push(`${evid("blocked")} 受限`);
			const head = `验收：${title}（${counts.join(" / ")}）`;
			const body = items.map((i) => {
				const tag = isClaimedOnly(i) ? "仅声称" : (VERIFY_STYLE[i.state]?.label ?? "待验证");
				const ev = i.evidence ? ` — 证据：${oneLine(String(i.evidence), 200)}` : "";
				return `- [${tag}] ${oneLine(String(i.claim), 200)}${ev}`;
			});
			const note = claimed
				? ["", `注意：有 ${claimed} 条标了 verified 但没给证据，已按「仅声称」处理。补上命令/文件:行号/实测值，或改成 pending。`]
				: [];
			return {
				content: [{ type: "text" as const, text: [head, ...body, ...note].join("\n") }],
				details: { title, items },
			};
		},
	});

	// ------------------------------------------------------------ bash 注解包装
	// 内置 bash 工具只有 command/timeout，没有 description。这里以原生 createBashToolDefinition
	// 为底层委托，仅补充可选的 description 字段，引导模型每次调用时用一句简短中文说明意图；
	// 渲染层优先展示 description，漏填时回退 describeShellZh，彻底告别原始 stdout 噪音。
	if (typeof createBashToolDefinition === "function") {
		try {
			const baseBash = createBashToolDefinition(process.cwd());
			const baseGuidelines = Array.isArray(baseBash.promptGuidelines) ? baseBash.promptGuidelines : [];
			pi.registerTool({
				...baseBash,
				parameters: Type.Object({
					command: Type.String({ description: "Shell command to execute" }),
					description: Type.Optional(
						Type.String({
							description:
								"用一句简短中文（8-25字）概括这一步命令做了什么，展示在执行日志右侧（如「查看当前目录和 package.json」「提取崩溃日志冻结前后记录」），不要照抄命令原文",
						}),
					),
					timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
				}),
				promptGuidelines: [
					...baseGuidelines,
					"每次调用 bash 时，务必填写 description：用一句简短中文（8–25 字）说明这一步做了什么（例如「查看当前目录和 package.json」「搜索冻结日志中的错误记录」），不要照抄命令原文。",
				],
				async execute(toolCallId, params, signal, onUpdate, ctx) {
					return baseBash.execute(
						toolCallId,
						{ command: (params as any).command, timeout: (params as any).timeout },
						signal,
						onUpdate,
						ctx,
					);
				},
			});
		} catch (e) {
			if (process.env.PI_HUD_DEBUG) console.error("[tool-hud] 包装 bash 工具失败：", e);
		}
	}

	/** L4：把本轮统计收成一条独立卡片，同时清掉 L1 的 footer 状态 */
	function flushTask(ctx: any) {
		if (ctx?.hasUI) ctx.ui.setStatus("hud-task", undefined);
		const snapshot: TaskSummary | undefined = turn.ops
			? {
					ops: turn.ops,
					ok: turn.ok,
					failed: turn.failed,
					modFiles: [...turn.modFiles],
					mutated: turn.mutated,
					verify: turn.verify,
					recovered: turn.failed > 0 && turn.ok > turn.okAtLastFail,
					lastOkLabel: turn.lastOkLabel,
					durationMs: turn.startedAt ? Date.now() - turn.startedAt : 0,
				}
			: undefined;
		turn = newTurn();
		// 一两次调用不值得再落一张卡：层级不是靠卡片数量堆出来的
		if (!snapshot || (snapshot.ops < 3 && !snapshot.failed)) return;
		// 纯只读 + 没声明验收：不落卡。查询任务没有「验收」这个维度，
		// 硬挂一张「检查通过 / 尚未验收」的半截卡只是噪音。
		if (!snapshot.failed && !snapshot.verify && isReadonlyTurn(snapshot)) return;
		try {
			pi.appendEntry("hud_task_summary", snapshot);
		} catch (e) {
			if (process.env.PI_HUD_DEBUG) console.error("[tool-hud] appendEntry 失败：", e);
		}
	}

	// 带上安全网：agent_end 之外还有两条路会让本轮结束。
	// flushTask 本身幂等（统计用完就清零），所以重复调用不会多落卡片。
	pi.on("agent_settled", (_event: any, ctx: any) => {
		if (mode === "off") return;
		flushTask(ctx ?? latestCtx);
	});
	pi.on("session_shutdown", () => {
		// 退出/中断时别把「任务 N 项」永远留在 footer 上
		if (latestCtx?.hasUI) latestCtx.ui.setStatus("hud-task", undefined);
	});

	// L1 + L4 的数据源：每次工具结束记一笔，footer 状态原地更新（不追加历史）
	pi.on("tool_result", (event: any, ctx: any) => {
		if (mode === "off") return;
		latestCtx = ctx ?? latestCtx;
		const name = String(event?.toolName ?? "");
		const raw = shortToolName(name);
		const input = event?.input ?? {};
		if (!turn.ops) turn.startedAt = Date.now();
		turn.ops += 1;
		if (event?.isError === true) {
			turn.failed += 1;
			turn.okAtLastFail = turn.ok;
			// 失败前那次成功不能当「后续恢复」的证据，清掉
			turn.lastOkLabel = undefined;
		} else {
			turn.ok += 1;
			// 只有「会检查东西」的命令才算恢复证据；
			// hud_verify / read 这类记账与读取调用写进「后续…通过」里没有任何信息
			if (raw === "bash" || raw === "powershell") {
				const desc = typeof input?.description === "string" ? oneLine(input.description, 16) : "";
				turn.lastOkLabel = desc || describeShell(String(input?.command ?? ""));
			}
		}
		if (raw === "write" || raw === "edit" || raw === "apply_patch") {
			const path = relPath(pathOfInput(input) ?? "", ctx?.cwd ?? process.cwd());
			if (path) turn.modFiles.add(path);
		}
		if (raw === "bash" || raw === "powershell") {
			if (isMutatingShell(String(input?.command ?? ""))) turn.mutated = true;
		}
		if (raw === "hud_verify") {
			turn.verify = tallyVerify(input);
			// 任务标识只从真数据来（验收卡标题）；没有就不编
			const title = typeof input?.title === "string" ? oneLine(input.title, 20) : "";
			if (title) turn.taskLabel = title;
		}
		if (ctx?.hasUI) {
			// 当前动作取自「刚完成的那次调用」的目标 —— 抽象阶段名（查看/执行/修改）会在
			// 一次探索里反复横跳，看不出到底在做什么；目标本身就说明在做什么
			const label = turn.taskLabel ?? "Tool HUD";
			const act = wbAct(name, input, ctx.cwd ?? process.cwd());
			// hud_verify 之类的目标可能就等于任务名，指两遍只是占位宽
			const bits = act && act !== label ? [label, act] : [label];
			bits.push(`${turn.ops} 项`, `✓ ${turn.ok}`);
			const text = bits.join(" · ") + (turn.failed ? ` · ✗ ${turn.failed}` : "");
			ctx.ui.setStatus("hud-task", text);
		}
	});

	// L4：任务结束卡片是 custom entry，不进模型上下文，只给人看
	pi.registerEntryRenderer("hud_task_summary", (entry: any, options: any, theme: Theme) => {
		if (mode === "off") return undefined;
		const data = entry?.data as TaskSummary | undefined;
		if (!data) return undefined;
		return new LazyBlock((width) => renderTaskCard(data, width, theme, options?.expanded === true));
	});

	pi.registerToolRenderer((toolName, next) => {
		if (mode === "off") return next();
		// 验收卡不是「工具执行日志」，不参与折叠/隐藏，单独画
		if (toolName === "hud_verify") {
			return {
				renderShell: "self",
				renderCall() {
					// 结果由 renderResult 画；这里返回空，避免首帧出现两张卡
					return new LazyBlock(() => []);
				},
				renderResult(result: any, options: { isPartial: boolean }, theme: Theme, context: any) {
					return new LazyBlock((width) =>
						renderVerifyCard(result?.details, width, theme, options.isPartial, context?.expanded === true),
					);
				},
			};
		}

		return {
			renderShell: "self",

			renderCall(args: Record<string, any>, theme: Theme, context: any) {
				context.state.args = args;
				// 序号和重复标记只分配一次：renderCall 每次刷新都会重跑
				if (context.state.seq === undefined) {
					context.state.seq = ++seqCounter;
					const key = repeatKey(toolName, args ?? {});
					if (key) {
						const prev = repeatSeen.get(key);
						if (prev === undefined) repeatSeen.set(key, context.state.seq);
						else context.state.dupOf = prev;
					}
					// 阶段只进 footer（在 tool_result 里由已完成的调用决定）。
					// 消息区不再打阶段标题：transcript 只能追加，事后分组会把不相关的行
					// 盖到上一个段头下面（F1），所以宁可不分组。
				}
				const seq = context.state.seq;

				return new LazyBlock((width) => {
					const state = context.state;
					const result = state.result;
					const isPartial = state.isPartial ?? !result;
					// 注意：传给 renderResult 的 result 被剥掉了 isError，权威来源是 context.isError
					const isError = context.isError === true || result?.isError === true;

					// 按 result 引用 + 错误/流式状态缓存派生结果，避免每帧重绘重复 JSON.parse 和全量扫描
					let cached = state._hudCache as
						| {
								result: any;
								isError: boolean;
								isPartial: boolean;
								text: string;
								truncated: boolean;
								status: Status;
						  }
						| undefined;
					if (!cached || cached.result !== result || cached.isError !== isError || cached.isPartial !== isPartial) {
						const text = result ? textOf(result) : "";
						const truncated = result?.details?.truncation?.truncated === true;
						const baseStatus = statusOf(toolName, text, isError, isPartial || !result);
						// 调用成功但输出被截断 = 结果不完整，单独一个状态
						const status: Status = truncated && baseStatus === "ok" ? "partial" : baseStatus;
						cached = { result, isError, isPartial, text, truncated, status };
						state._hudCache = cached;
					}

					const action = actionOf(toolName, state.args ?? args, context.cwd);
					const { text, truncated, status } = cached;

					// hidden 模式：只留「有问题的」，成功的过程不占屏
					if (mode === "hidden" && (status === "ok" || status === "empty")) return [];

					// tag 在下面「展开 → 参数/原始输出」那段还要用，必须在 if/else 外面声明
					const tag = shortToolName(toolName);
					let line = "";
					if (mode === "wb") {
						const callArgs = state.args ?? args;
						const isShell = tag === "bash" || tag === "powershell";
						// WorkBuddy 简洁执行：
						//   - shell 命令：⊙ 简短命令  ·  中文一句话概括（模型 description 优先，漏填用中文规则兜底）
						//   - 其它工具：⊙ 目标 + 增删行数 / 计数 / 结构化摘要
						line = wbLine({
							theme,
							status,
							target: wbTarget(toolName, callArgs, context.cwd),
							stats: isShell
								? wbShellNote(toolName, callArgs)
								: wbDiff(toolName, callArgs, result) ||
									wbCount(toolName, result, text) ||
									(config.resultDigest && (status === "ok" || status === "partial")
										? (digestOf(toolName, text, result) ?? "")
										: ""),
							durationMs: context.durationMs,
							showDuration: config.wbDuration,
							width,
						});
					} else {
						const glyph = STATUS_GLYPH[status];
						// Grok 轨迹风格（compact）：
						//   ✓  ◎ path/to/file
						//   ✓  ⌕「pattern」@ file
						// 不显示序号 / 工具名 / 行数；成功只保留耗时，失败才露完整 meta。
						// detail 模式保留完整信息。
						const isShell = tag === "bash" || tag === "powershell";
						const icon =
							action.label === tag || (isShell && action.label === ACTION_ICON.run) ? "" : action.label;
						const trail = mode === "compact"; // 轨迹模式：更少装饰
						// 成功行的一句话结论：结构化输出给字段摘要，其余给第一条有信息量的行
						const digest = config.resultDigest && status === "ok" ? digestOf(toolName, text, result) : undefined;
						const meta = summarize(
							toolName,
							state.args ?? args,
							result,
							isError,
							status === "running",
							context.durationMs,
							digest,
						);
						// compact 只在失败 / 运行中显示完整 meta；detail 全显。
						const showMeta = !trail || status === "error" || status === "running" || status === "warn";
						// compact 的成功行补「结果 + 耗时」：结果决定下一步，耗时决定要不要重排。
						const metaText = showMeta
							? meta
							: [
									digest,
									context.durationMs !== undefined && context.durationMs !== null
										? fmtDuration(context.durationMs)
										: undefined,
								]
									.filter(Boolean)
									.join("  ");

						const dupText =
							!trail && state.dupOf !== undefined
								? `  ↳ 同 [${String(state.dupOf).padStart(2, "0")}]`
								: "";
						const outLineCount = text ? text.split("\n").length : 0;
						const wantHint =
							!trail && (outLineCount > 6 || truncated) && !context.expanded && mode !== "detail";
						const hintText = wantHint ? `  (${expandKey} 展开)` : "";

						// 轨迹行：glyph + icon + target；detail 行额外带序号和工具名
						const headPlain = trail
							? `${glyph}  ${icon}${icon && action.target ? " " : ""}`
							: `${glyph} [${String(seq).padStart(2, "0")}] ${tag}${icon ? `  ${icon}` : ""}`;
						const metaPlain = metaText ? `  ·  ${metaText}` : "";
						const base = visibleWidth(headPlain) + visibleWidth(metaPlain);
						let keepHint = Boolean(hintText);
						let keepDup = Boolean(dupText);
						const fits = () =>
							base +
								(keepDup ? visibleWidth(dupText) : 0) +
								(keepHint ? visibleWidth(hintText) : 0) +
								2 +
								12 <=
							width;
						if (!fits() && keepHint) keepHint = false;
						if (!fits() && keepDup) keepDup = false;

						const tailWidth = (keepDup ? visibleWidth(dupText) : 0) + (keepHint ? visibleWidth(hintText) : 0);
						const room = Math.max(16, Math.min(80, width - base - tailWidth - 2));
						const target = action.target ? truncateToWidth(action.target, room, "…") : "";

						// 统一的「一句话」配色：状态只由 glyph 一个字符表达，其余文字一律 muted/dim，
						// 与底部快捷键提示行（dim 键位 + muted 说明 + muted 分隔符）同一套色阶，
						// 不再用 accent/warning/error 把整块刷成彩色的，也不再 bold。
						line = `${theme.fg(STATUS_COLOR[status], glyph)}`;
						if (trail) {
							// Grok 轨迹：状态 + 图标 + 目标，无序号无工具名
							if (icon) line += `  ${theme.fg("muted", icon)}`;
							if (target) line += `${icon ? " " : "  "}${theme.fg("muted", target)}`;
							else if (!icon) line += `  ${theme.fg("muted", tag)}`;
						} else {
							line += ` ${theme.fg("dim", `[${String(seq).padStart(2, "0")}]`)} ${theme.fg("muted", tag)}`;
							if (icon) line += `  ${theme.fg("muted", icon)}`;
							if (target) line += `  ${theme.fg("muted", target)}`;
						}
						if (metaText) {
							line += `${theme.fg("muted", "  ·  ")}${theme.fg("dim", metaText)}`;
						}

						if (keepDup) {
							line += `  ${theme.fg("dim", `↳ 同 [${String(state.dupOf).padStart(2, "0")}]`)}`;
						}
						if (keepHint) line += `  ${theme.fg("dim", `(${expandKey} 展开)`)}`;
					}

					// 消息区只记「发生了什么」：一次调用一行，不带段头、不嵌缩进
					const lines: string[] = [line];

					// 失败：错误详情始终露出，折叠也不吞
					// L3 异常级：失败出日志流，独立成卡（标题 + 原因 + 建议 + 原始输出）。
					// 折叠也保留结论，展开才堆原文 —— 不用为了排障重读整段输出。
					if (status === "error" && result) {
						const errLines = text.split("\n").filter((l) => l.trim());
						// pi 把「Command exited with code N」拼在正文最后。它是结论、不是报错正文，
						// 单独拎出来放卡底：既能显示第一条真实报错，也不会丢掉退出码。
						const statusLine = errLines.find((l) => SHELL_STATUS_RE.test(l.trim()));
						const body = statusLine ? errLines.filter((l) => l !== statusLine) : errLines;
						const hits = body.filter((l) => ERROR_LINE_RE.test(l));
						// 「npm error code 1」「Traceback (most recent call last):」这类是汇总行/表头，不是原因。
						// 排序让真正那句报错先出现，避免卡里第一行是噪声。
						const rank = (l: string) => {
							const t = l.trim();
							if (/^Traceback \(most recent call last\):?$/i.test(t)) return 3;
							if (/^(?:npm|yarn|pnpm) error (?:code|command failed)/i.test(t)) return 2;
							if (/(?:error|exception|fatal|错误|失败)\s*[:：]|\bTS\d{3,}\b|requires? --[a-z]/i.test(t)) return -1;
							return 0;
						};
						const picked0 = [...hits].sort((a, b) => rank(a) - rank(b))[0] ?? body[0] ?? "";
						// 真任务里很常见：命令什么都不输出、只靠退出码失败。
						// 直接把 "(no output)" 贴上去等于没说话。
						const reason =
							!picked0 || /^\(no output\)$/i.test(picked0.trim())
								? "命令没有任何输出，只能凭退出码判为失败"
								: picked0;
						const hint = config.fixHint ? fixHintOf(text) : undefined;
						const w = Math.max(24, Math.min(width, 96));

						lines.push(cardTop("✗ 执行失败", w, theme));
						// 标签列沿用全卡 6 列宽（中文 2 列/字 + 2 空格）：原因 / 推断 都是两个字，
						// 文字起点才对得齐。四个字的「可能原因」宽 8 列，会把这行文字往右推两列。
						// 「推断」与「可能原因」同义，但不把规则匹配出的猜测说成结论
						lines.push(...cardBlock("原因  ", oneLine(reason, 200), w, theme, { color: "error", wrap: true }));
						if (hint) lines.push(...cardBlock("推断  ", hint, w, theme));
						if (context.expanded) {
							lines.push(...cardBlock("", `原始输出 ${body.length} 行`, w, theme, { dim: true }));
							const limit = Math.min(body.length, config.expandedMaxLines);
							for (const l of body.slice(0, limit)) lines.push(...cardBlock("", l, w, theme, { dim: true }));
							if (body.length > limit) {
								lines.push(...cardBlock("", `… 另有 ${body.length - limit} 行未显示`, w, theme, { dim: true }));
							}
						} else if (body.length > 2) {
							lines.push(...cardBlock("", `另有 ${body.length - 1} 行原始输出（${expandKey} 展开）`, w, theme, { dim: true }));
						}
						lines.push(cardBottom(statusLine ? oneLine(statusLine.trim(), 60) : "执行失败", w, theme, "error"));
						return lines;
					}

					// 警告：折叠状态也露前几行，方便直接定位
					if (status === "warn" && result && !context.expanded && mode !== "detail") {
						const hits = text.split("\n").filter((l) => WARN_LINE_RE.test(l)).slice(0, config.errorLines);
						for (const l of hits) lines.push(theme.fg("muted", `  ${oneLine(l, 110)}`));
					}

					// 展开 / detail 模式：给原始输出
					if (result && (context.expanded || mode === "detail")) {
						const out = text.split("\n");
						// 展开 = 完整原始输出（只有超长才截，且明确写出来）；detail = 固定几行
						const limit = context.expanded ? Math.min(out.length, config.expandedMaxLines) : config.detailLines;
						if (context.expanded) {
							lines.push(
								theme.fg(
									"muted",
									`  工具 ${tag} · 参数 ${oneLine(JSON.stringify(state.args ?? args ?? {}), 160)}`,
								),
							);
							// 先给结论再给原文：展开是为了核对细节，不是为了自己重读一遍输出
							const verdict = config.resultDigest ? digestOf(tag, text, result) : undefined;
							lines.push(
								theme.fg(STATUS_COLOR[status], `  ${STATUS_GLYPH[status]} ${STATUS_WORD[status]}`) +
									theme.fg("dim", verdict ? ` · ${verdict}` : ""),
							);
							lines.push(theme.fg("dim", `  ── 原始输出 ${out.length} 行 ──`));
						}
						if (out.length <= limit) {
							for (const l of out) lines.push(theme.fg("muted", `  ${l}`));
						} else {
							// 超长时保留「头 + 尾」：日志的结论几乎总在末尾，只给头等于没给
							const head = Math.ceil(limit * 0.6);
							const tail = limit - head;
							for (const l of out.slice(0, head)) lines.push(theme.fg("muted", `  ${l}`));
							lines.push(theme.fg("dim", `  … 中间省略 ${out.length - limit} 行 …`));
							if (tail > 0) for (const l of out.slice(-tail)) lines.push(theme.fg("muted", `  ${l}`));
						}
						if (truncated && result.details?.fullOutputPath) {
							lines.push(theme.fg("dim", `  完整输出：${result.details.fullOutputPath}`));
						}
					}

					return lines;
				});
			},

			renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, _theme: Theme, context: any) {
				context.state.result = result;
				context.state.isPartial = options.isPartial;
				// 所有内容都由 renderCall 那一行负责，这里不再追加第二行
				return new LazyBlock(() => []);
			},
		};
	});

	// ------------------------------------------------------------ 坏图拦截
	// 上游对坏图是「整轮 400」，而且坏图会留在历史里，之后每轮都失败。
	// 这里在工具结果落库前验一遍，坏的那张换成文字，其余内容原样保留。
	pi.on("tool_result", (event) => {
		if (mode === "off") return;
		if (!config.validateImages) return;
		const content = event.content ?? [];
		if (!content.some((part) => part.type === "image")) return;

		let changed = false;
		const next = content.map((part) => {
			if (part.type !== "image") return part;

			// Buffer.from 对坏 base64 不抛错，只会静默截断，所以显式检查
			if (typeof part.data !== "string") {
				changed = true;
				return { type: "text" as const, text: "[image dropped: missing or non-string data]" };
			}
			const bytes = Buffer.from(part.data, "base64");
			if (!bytes.length) {
				changed = true;
				return { type: "text" as const, text: "[image dropped: empty payload]" };
			}

			const problem = imageProblem(part.mimeType, bytes);
			if (!problem) return part;

			changed = true;
			return {
				type: "text" as const,
				text: `[image dropped before sending: ${problem}. These bytes are not a valid ${part.mimeType || "image"}, and the provider would reject the whole request with image_invalid. Create a real image file and try again.]`,
			};
		});

		if (!changed) return;
		return { content: next };
	});

	// ------------------------------------------------------------ 上下文减负
	// 注意：这会改变发给模型的历史内容，因此默认关闭。
	// 规则是确定性的（同一条历史每次得到同样的占位符），所以只在某条结果「跨过保留边界」时
	// 造成一次前缀缓存失效，不会每轮都失效。
	pi.on("context", (event) => {
		// mode=off 表示「完全不干预」，连数据层也不动
		if (mode === "off") return;
		if (!config.trimOldResults) return;

		const messages = event.messages as any[];
		const indexes: number[] = [];
		for (let i = 0; i < messages.length; i++) {
			if (messages[i]?.role === "toolResult") indexes.push(i);
		}
		const cutoff = indexes.length - config.keepRecentResults;
		if (cutoff <= 0) return;

		let changed = false;
		const next = messages.slice();

		for (let k = 0; k < cutoff; k++) {
			const index = indexes[k]!;
			const message = messages[index];
			// 验收卡的内容在 details 里，瘦身会把 details 一起抹掉 → 卡片变成「没有验收项」。
			// 它是记录不是日志，永远不瘦。
			if (message.toolName === "hud_verify") continue;
			const text = textOf(message);
			if (text.length < 600) continue; // 小的不折腾，省得破坏可读性

			const lineCount = text.split("\n").length;
			const stub = `[${message.toolName} output elided: ${lineCount} ${lineCount === 1 ? "line" : "lines"} / ${text.length} chars. Re-run the tool if you need it again.]`;
			next[index] = { ...message, content: [{ type: "text", text: stub }], details: undefined };
			changed = true;
		}

		if (changed) return { messages: next };
	});
}
