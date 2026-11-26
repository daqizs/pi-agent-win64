/**
 * Security Guard Extension
 *
 * pi 本身没有权限系统（settings.schema.json 里只有 defaultProjectTrust），
 * bash / write 是完全放开的。这个扩展补两条边界：
 *
 *   1. 破坏性命令 —— `rm -rf ~`、`rm -rf` 掉 cwd 或它的祖先、`git reset --hard`、
 *      `git clean -fdx`、`mkfs`、`dd of=/dev/*`、`curl | sh`、fork bomb、
 *      `DROP TABLE` 之类。命中即 block。
 *   2. 凭据文件 —— 读取 / 复制 / 覆盖 `.ssh/id_*`、`.aws/credentials`、
 *      `~/.git-credentials`、`.env*`、CodeBuddy 的 `auth/*.info`（明文 JWT）等。
 *      命中即 block，避免密钥进上下文。
 *
 * 环境变量：
 *   PI_SECURITY_GUARD=0   临时关闭（只关拦截，不影响 pi 启动）
 *
 * 判定逻辑是纯函数（evaluate / evaluateShellCommand / evaluatePath），
 * 单测：node ~/.pi/agent/_dev/security-guard.test.mjs
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";

export interface Verdict {
	block: boolean;
	reason?: string;
}

interface Ctx {
	home: string;
	cwd: string;
}

const OK: Verdict = { block: false };

// ---------------------------------------------------------------- 路径处理

/** 归一化：展开 ~ / $HOME / %USERPROFILE%，转 msys 的 /c/ 前缀，小写，去掉尾斜杠。 */
function normalize(input: string, ctx: Ctx): string {
	let p = input.trim().replace(/^["']|["']$/g, "");
	p = p.replace(/%USERPROFILE%/gi, ctx.home);
	p = p.replace(/^\$HOME\b|^\$\{HOME\}/i, ctx.home);
	if (p === "~") p = ctx.home;
	else if (p.startsWith("~/") || p.startsWith("~\\")) p = ctx.home + p.slice(1);
	p = p.replace(/\\/g, "/");
	// Git Bash 的 /c/Users/... → c:/Users/...
	if (/^\/[a-z]\//i.test(p)) p = p.slice(1, 2) + ":" + p.slice(2);
	p = p.replace(/\/+/g, "/").toLowerCase();
	if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
	return p;
}

/** 把相对路径解析到绝对路径（手写，避免 node:path 在 msys 风格路径上跑偏）。 */
function resolve(input: string, ctx: Ctx): string {
	let p = normalize(input, ctx);
	if (/^[a-z]:$/.test(p)) return p + "/";
	const isAbs = /^[a-z]:\//.test(p) || p.startsWith("/");
	if (!isAbs) p = normalize(ctx.cwd, ctx) + "/" + p;
	const parts: string[] = [];
	for (const seg of p.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	const joined = parts.join("/");
	return /^[a-z]:/.test(joined) ? joined : "/" + joined;
}

function isSameOrAncestor(candidate: string, of: string): boolean {
	if (candidate === of) return true;
	return of.startsWith(candidate + "/");
}

/** 删掉就等于删掉整个配置体系的根。只挡"整体删"，删里面的单个文件不挡。 */
function guardedRoots(ctx: Ctx): string[] {
	return [
		normalize("~/.pi", ctx),
		normalize("~/.pi-profile-switch", ctx),
		normalize("~/.caveman", ctx),
		normalize("~/.agents", ctx),
		normalize("~/.ssh", ctx),
		"c:/windows",
	];
}

function dangerousTarget(target: string, ctx: Ctx): string | null {
	const abs = resolve(target, ctx);
	const home = normalize(ctx.home, ctx);
	const cwd = resolve(ctx.cwd, ctx);

	if (/^[a-z]:?$/.test(abs) || abs === "/" || /^[a-z]:\/$/.test(abs))
		return "整个磁盘或根目录";
	if (abs === home || abs === home + "/*") return "整个用户目录";
	for (const root of guardedRoots(ctx)) {
		if (abs === root) return `关键目录 ${root}`;
	}
	if (isSameOrAncestor(abs, cwd)) return "当前工作目录或它的上级";
	return null;
}

// ---------------------------------------------------------------- 命令扫描

/** 按 && || ; | 换行 切成独立命令段，粗分够用（不处理引号内的分隔符，宁可漏判不误判）。 */
function segments(command: string): string[][] {
	return command
		.split(/&&|\|\||[;|\n]/)
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => s.split(/\s+/).filter(Boolean));
}

const WRAPPERS = new Set(["sudo", "nohup", "env", "command", "time", "xargs", "eval"]);

function stripWrappers(tokens: string[]): string[] {
	let i = 0;
	while (i < tokens.length && WRAPPERS.has(tokens[i].toLowerCase())) i++;
	return tokens.slice(i);
}

function hasFlag(tokens: string[], letters: string): boolean {
	return tokens.some((t) => /^-[a-z]+$/i.test(t) && [...letters].every((c) => t.toLowerCase().includes(c)));
}

function isRecursive(tokens: string[]): boolean {
	return hasFlag(tokens, "r") || tokens.some((t) => /^--recursive$/i.test(t) || /^--no-preserve-root$/i.test(t));
}

interface Rule {
	re: RegExp;
	why: string;
}

/** 简单正则型规则：命中即 block。都是"绝不可能是正常操作"的那类。 */
const RULES: Rule[] = [
	{ re: /\bgit\s+reset\s+--hard\b/, why: "git reset --hard 会丢掉所有未提交改动" },
	{ re: /\bgit\s+clean\s+-[a-z]*f[a-z]*d?[a-z]*\b/, why: "git clean -f 会删掉所有未跟踪文件（含日志、环境文件）" },
	{ re: /\bgit\s+checkout\s+--\s+\./, why: "git checkout -- . 会丢掉所有工作区改动" },
	{ re: /\bmkfs(\.|\s|$)/, why: "mkfs 会格式化分区" },
	{ re: /\bdd\b[^|]*\bof=\/dev\/(sd|nvme|hd|disk)/, why: "dd 写裸设备会毁掉分区" },
	{ re: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/, why: "fork bomb" },
	{ re: /\bdrop\s+(table|database|schema)\b/, why: "DROP 会删表/删库" },
	{ re: /\btruncate\s+table\b/, why: "TRUNCATE 会清空表" },
	{ re: /\bchmod\s+-[a-z]*r[a-z]*\s+777\s+\/(\s|$)/, why: "递归 777 整个根目录" },
	{ re: /\b(format|diskpart)\s+[a-z]:/, why: "格式化磁盘" },
	{ re: /\b(curl|wget)\b[^|;]*\|\s*(ba|z|fi|da)?sh\b/, why: "把网络内容直接管道给 shell 执行 —— 任意代码执行" },
	{ re: />\s*\/dev\/(sd|nvme|hd|disk)/, why: "重定向写入裸设备" },
];

export function evaluateShellCommand(command: string, ctx: Ctx = { home: homedir(), cwd: process.cwd() }): Verdict {
	const raw = command.replace(/\\\r?\n/g, " ");
	const lower = raw.toLowerCase();

	for (const rule of RULES) {
		if (rule.re.test(lower)) return { block: true, reason: rule.why };
	}

	for (const seg of segments(raw)) {
		const tokens = stripWrappers(seg);
		if (!tokens.length) continue;
		const head = tokens[0].toLowerCase().replace(/^.*\//, "");

		if (head === "rm") {
			if (!isRecursive(tokens)) continue;
			const force = hasFlag(tokens, "f") || tokens.some((t) => /^--force$/i.test(t));
			const targets = tokens.slice(1).filter((t) => !t.startsWith("-"));
			for (const t of targets) {
				const hit = dangerousTarget(t, ctx);
				if (hit)
					return {
						block: true,
						reason: `rm ${force ? "-rf" : "-r"} 的目标是${hit}（${t}），拒绝执行。要清理具体子目录请指明完整子路径。`,
					};
			}
		}
	}
	return evaluateShellSecrets(command, ctx);
}

// ---------------------------------------------------------------- 凭据文件

/** 读/拷/改这些文件会把密钥带进上下文。 */
const SECRET_PATTERNS: Array<{ re: RegExp; what: string }> = [
	{ re: /\/\.ssh\/id_[^/]*$/, what: "SSH 私钥" },
	{ re: /\/\.ssh\/[^/]*_(rsa|ed25519|ecdsa|dsa)$/, what: "SSH 私钥" },
	{ re: /\/\.aws\/credentials$/, what: "AWS 凭据" },
	{ re: /\/\.git-credentials$/, what: "Git 凭据" },
	{ re: /\/\.netrc$|\/_netrc$/, what: "netrc 凭据" },
	{ re: /\/\.docker\/config\.json$/, what: "Docker registry 凭据" },
	{ re: /\/\.env(\.[a-z0-9]+)?$/, what: "环境变量文件（通常含密钥）" },
	{ re: /\/auth\/[^/]*\.info$/, what: "CodeBuddy 明文 JWT" },
	{ re: /\.(p12|pfx|keystore|jks)$/, what: "证书私钥库" },
];

export function evaluatePath(toolName: string, target: string, ctx: Ctx = { home: homedir(), cwd: process.cwd() }, mode: "read" | "write" = "read"): Verdict {
	const abs = resolve(target, ctx);
	for (const { re, what } of SECRET_PATTERNS) {
		if (re.test(abs))
			return {
				block: true,
				reason: `${what}（${target}）不通过工具${mode === "read" ? "读取" : "改写"} —— 会把凭据带进上下文。确需处理请让用户自己操作，或用 PI_SECURITY_GUARD=0 关闭守卫。`,
			};
	}
	return OK;
}

/** bash 里的 cat / cp / type / Get-Content 等对凭据文件的访问。 */
export function evaluateShellSecrets(command: string, ctx: Ctx = { home: homedir(), cwd: process.cwd() }): Verdict {
	for (const seg of segments(command)) {
		const tokens = stripWrappers(seg);
		if (!tokens.length) continue;
		const head = tokens[0].toLowerCase().replace(/^.*\//, "");
		if (!["cat", "type", "more", "head", "tail", "cp", "copy", "scp", "rsync", "get-content", "gc", "less", "strings", "base64"].includes(head))
			continue;
		for (const t of tokens.slice(1).filter((x) => !x.startsWith("-"))) {
			const v = evaluatePath("bash", t, ctx, "read");
			if (v.block) return v;
		}
	}
	return OK;
}

// ---------------------------------------------------------------- 汇总

const READ_TOOLS = new Set(["read"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const HTML_TOOLS = new Set(["grep", "find", "ls"]);
/** 输入里装的是 shell 脚本 / SQL / 代码的工具。 */
const CMD_KEYS = ["command", "cmd", "script", "sql"];
const PATH_KEYS = ["path", "file_path", "filePath", "file", "target", "dir"];

/** codemode 的 input.code 是任意 JS，扫它只会误报——里面的 bash 调用会自己再进一次 hook。 */
const SKIP_CMD_SCAN = new Set(["codemode", "edit"]);

export function evaluate(toolName: string, input: Record<string, unknown> | undefined, ctx?: Ctx): Verdict {
	if (!input) return OK;
	const c: Ctx = ctx ?? { home: homedir(), cwd: process.cwd() };

	if (toolName === "bash" || toolName === "powershell") {
		const command = input.command;
		if (typeof command !== "string" || !command) return OK;
		return evaluateShellCommand(command, c);
	}

	const declared = input.path ?? input.file_path ?? input.filePath;
	if (typeof declared === "string" && declared) {
		if (READ_TOOLS.has(toolName) || HTML_TOOLS.has(toolName)) return evaluatePath(toolName, declared, c, "read");
		if (WRITE_TOOLS.has(toolName)) return evaluatePath(toolName, declared, c, "write");
	}

	// MCP 与其它自定义工具：不知道语义，就按参数名猜。
	// （deepseek-shell 的 shell_exec / local_file_read 就是靠这层拦的）
	if (!SKIP_CMD_SCAN.has(toolName)) {
		for (const k of CMD_KEYS) {
			const v = input[k];
			if (typeof v === "string" && v) {
				const verdict = evaluateShellCommand(v, c);
				if (verdict.block) return verdict;
			}
		}
	}
	for (const k of PATH_KEYS) {
		const v = input[k];
		if (typeof v !== "string" || !v) continue;
		const verdict = evaluatePath(toolName, v, c, "read");
		if (verdict.block) return verdict;
	}
	return OK;
}

export default function securityGuard(pi: ExtensionAPI): void {
	if (process.env.PI_SECURITY_GUARD === "0") return;

	pi.on("tool_call", (event) => {
		const verdict = evaluate(event.toolName, event.input as Record<string, unknown> | undefined);
		if (!verdict.block) return undefined;
		return { block: true, reason: `[security-guard] ${verdict.reason}` };
	});
}
