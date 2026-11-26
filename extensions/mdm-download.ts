/**
 * Mister Download Manager Extension
 *
 * 把 Mister Download Manager 作为 pi 的**可选**下载器之一：
 *   1. 注册 `mdm_download` 工具 —— 适合大文件、断点续传、镜像加速的下载。
 *   2. 注册 `tool_call` 守卫（**默认关闭**，需显式开启）—— 开启后拦下 bash / powershell
 *      里"用 curl / wget 存文件"的命令，引导模型改走 mdm_download。
 *
 * 环境变量：
 *   MDM_PATH      自定义 misterdownloadmanager.exe 路径（默认自动探测常见安装位置）
 *   PI_MDM_GUARD  "1"/"true"/"on" 开启拦截；不设或 "0" 则关闭（默认）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const MDM_CANDIDATES = [
	"K:\\Mister Download Manager\\misterdownloadmanager.exe",
	"C:\\Program Files\\Mister Download Manager\\misterdownloadmanager.exe",
	"C:\\Program Files (x86)\\Mister Download Manager\\misterdownloadmanager.exe",
];

function resolveMdmPath(): string {
	const fromEnv = process.env.MDM_PATH?.trim();
	if (fromEnv) return fromEnv;
	return MDM_CANDIDATES.find((p) => existsSync(p)) ?? MDM_CANDIDATES[0];
}

interface MdmResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * 参数直接进 argv（execFile 不过 shell），所以 /d、/p 这类旗标不会被 MSYS 路径转换改写。
 * 手动在 Git Bash 里复现时需加 MSYS2_ARG_CONV_EXCL='*'，否则 /d 会被折成 D:\。
 */
function runMdm(args: string[]): Promise<MdmResult> {
	const exe = resolveMdmPath();
	return new Promise((resolve) => {
		execFile(exe, args, { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
			const code =
				err && typeof (err as NodeJS.ErrnoException).code === "number"
					? Number((err as unknown as { code: number }).code)
					: err
						? 1
						: 0;
			resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

// #region mdm-guard —— 纯判定逻辑，_dev/mdm-guard.test.mjs 会原样抽出这段做单测

/**
 * `curl` / `wget` 这类词在一条命令里只有两种出现方式：
 *   1. 真的在执行它 —— 行首、管道/分隔符之后，或 sudo / nohup 之类包装器之后
 *   2. 只是被搜出来或打印出来 —— `rg "curl|wget" notes.md`、`echo curl`
 * 只有第 1 种才是下载。误拦第 2 种会逼着模型放弃正确写法去绕路，代价比漏拦大得多。
 */
const AT_CMD_POS = (name: string) =>
	new RegExp(`(?:^|[|;&(\\n]|\\b(?:sudo|env|nohup|time|xargs)\\b)\\s*${name}(?:\\.exe)?\\b`, "i");

const CURL_CMD = AT_CMD_POS("curl");
const WGET_CMD = AT_CMD_POS("wget");
/** 这两个在 PowerShell 里本身就是"搬文件"，见到就拦 */
const PS_TRANSFER = AT_CMD_POS("(?:Start-BitsTransfer|bitsadmin)");
/** Invoke-WebRequest / iwr 不带 -OutFile 只是把内容取回内存，不算下载 */
const PS_FETCH = AT_CMD_POS("(?:Invoke-WebRequest|iwr)");
const PS_WRITE = /(?:^|\s)(?:-OutFile\b|-o\b)/;

/** 无目标参数的落地旗标：-O / -J / --remote-name / --remote-header-name */
const CURL_SAVE_NO_TARGET = /(?:^|\s)(?:-[A-Za-z]*[OJ]\b|--remote-name\b|--remote-header-name\b)/;
/** 带目标参数的落地旗标：-o <target> / --output[= ]<target> */
const CURL_SAVE_TARGET =
	/(?:^|\s)(?:-[A-Za-z]*o\b|--output\b)(?:\s*=\s*|\s+)?("[^"]*"|'[^']*'|\S+)/;
/** 目标写的是"丢弃"而不是"存盘"：只要状态码时用 -o /dev/null（Windows 上是 NUL，或 - 表示 stdout） */
const DISCARD_TARGETS = new Set(["/dev/null", "nul", "-"]);

/**
 * 抹掉"只是文本"的内容，避免当成命令调用：
 *   - 引号内：`rg "curl|wget"` 是搜索模式，不是命令
 *   - heredoc 正文：`cat > doc.md <<'EOF'` 里的 curl 示例只是要写进文件
 */
const stripLiteralText = (command: string) =>
	command
		// heredoc 正文先抹，因为正文里可能含引号，会扰乱后面的引号处理
		.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, (m) => " ".repeat(m.length))
		.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, (m) => " ".repeat(m.length));

function looksLikeFileDownload(command: string): boolean {
	const bare = stripLiteralText(command);
	if (WGET_CMD.test(bare)) return true;
	if (PS_TRANSFER.test(bare)) return true;
	if (PS_FETCH.test(bare) && PS_WRITE.test(bare)) return true;
	if (!CURL_CMD.test(bare)) return false;
	if (CURL_SAVE_NO_TARGET.test(bare)) return true;
	// 目标值要从原始命令里取，因为 stripLiteralText 会把带引号的目标抹成空格
	const target = CURL_SAVE_TARGET.exec(command)?.[1];
	if (!target) return false;
	return !DISCARD_TARGETS.has(target.replace(/^["']|["']$/g, "").toLowerCase());
}

// #endregion mdm-guard

const GUARD_HINT = [
	"已被 pi 的下载器守卫拦截（因为设置了 PI_MDM_GUARD=1）：这条命令看起来在用 curl / wget 存文件。",
	"",
	"改用 mdm_download 工具，例如：",
	'  mdm_download({ url: "<下载链接>", saveDir: "<保存目录，可省>", fileName: "<文件名，可省>" })',
	"",
	"（守卫默认关闭；要临时放行请去掉 PI_MDM_GUARD 后重启 pi。）",
].join("\n");

/** 守卫是否开启：默认关闭，只有显式设置 PI_MDM_GUARD=1/true/on/yes 才拦截 */
const isGuardEnabled = () => /^(?:1|true|on|yes)$/i.test((process.env.PI_MDM_GUARD ?? "").trim());

export default function mdmDownloadExtension(pi: ExtensionAPI) {
	// ---------- 工具：mdm_download ----------
	pi.registerTool({
		name: "mdm_download",
		label: "MDM Download",
		description:
			"通过 Mister Download Manager 下载远程文件（大文件、断点续传、多线程加速时用）。" +
			"把链接交给下载器队列，可选指定保存目录与文件名。普通小文件用 curl 或 fetch_content 更直接。",
		promptSnippet: "Download a remote file with Mister Download Manager",
		promptGuidelines: [
			"mdm_download 适合大文件、需要断点续传或多线程加速的下载；小文件也可直接用 curl / fetch_content，按场景选省事的那条路。",
		],
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "要下载的完整 URL（http/https/ftp）" },
				saveDir: { type: "string", description: "保存目录（可选，如 D:\\Downloads）" },
				fileName: { type: "string", description: "自定义保存文件名（可选，如 myfile.zip）" },
				queueOnly: {
					type: "boolean",
					description: "true = 只加入下载队列不立即开始（/a）；默认 false = 立即开始下载",
				},
			},
			required: ["url"],
		},
		async execute(_toolCallId, params) {
			const url = String(params.url ?? "").trim();
			if (!url) throw new Error("mdm_download: url 不能为空");
			if (!/^(https?|ftp):\/\//i.test(url)) {
				throw new Error(`mdm_download: 不支持的链接（需 http/https/ftp）：${url}`);
			}
			const exe = resolveMdmPath();
			if (!existsSync(exe)) {
				throw new Error(
					`mdm_download: 找不到 misterdownloadmanager.exe（当前路径 ${exe}）。` +
						"请安装 Mister Download Manager，或设置环境变量 MDM_PATH 指向它。",
				);
			}

			const args = ["/d", url];
			if (params.saveDir) args.push("/p", String(params.saveDir));
			if (params.fileName) args.push("/f", String(params.fileName));
			if (params.queueOnly === true) args.push("/a");
			args.push("/n"); // 静默模式：不弹任何确认框

			const result = await runMdm(args);
			const shown = `"${exe}" ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`;

			// exe 是 GUI 启动器：把任务交给下载器后自己退出，退出码不可靠（冷启动时常见 1），不作为成败依据。
			// stderr 里只有 Qt 的 translations 噪声，过滤掉以免干扰判断。
			const noise = result.stderr
				.split(/\r?\n/)
				.filter((l) => l.trim() && !/^translations:/.test(l.trim()));
			const lines = [
				"✅ 已提交给 Mister Download Manager",
				`命令: ${shown}`,
				`启动器退出码: ${result.code}（GUI 启动器，仅供参考，不代表下载失败）`,
			];
			if (noise.length) lines.push(`stderr: ${noise.join(" | ")}`);
			lines.push(
				params.queueOnly === true
					? "任务已加入队列（未自动开始），打开 Mister Download Manager 可查看进度。"
					: "下载器已开始处理该任务，打开 Mister Download Manager 可查看进度。",
			);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { url, saveDir: params.saveDir ?? null, fileName: params.fileName ?? null, args, exitCode: result.code },
			};
		},
	});

	// ---------- 命令：/mdm ----------
	pi.registerCommand("mdm", {
		description: "查看 Mister Download Manager 状态：/mdm [url] —— 不带参数只看状态，带 url 则加入下载队列",
		handler: async (args, ctx) => {
			const url = (args ?? "").trim();
			if (!url) {
				const current = resolveMdmPath();
				const ok = existsSync(current);
				ctx.ui.notify(
					`Mister Download Manager: ${ok ? "✅ 已就绪" : "❌ 未找到 misterdownloadmanager.exe"}\n路径: ${current}\n守卫: ${
						isGuardEnabled() ? "已开启（拦截 curl/wget 下载）" : "已关闭（默认；PI_MDM_GUARD=1 可开启）"
					}`,
					ok ? "info" : "warning",
				);
				return;
			}
			try {
				const res = await runMdm(["/d", url, "/n"]);
				ctx.ui.notify(`已提交给 Mister Download Manager（退出码 ${res.code}）: ${url}`, "info");
			} catch (err) {
				ctx.ui.notify(`提交下载失败: ${String(err)}`, "error");
			}
		},
	});

	// ---------- 守卫：拦截 curl / wget 下载（默认关闭，PI_MDM_GUARD=1 才生效）----------
	if (!isGuardEnabled()) return;

	pi.on("tool_call", (event) => {
		const name = event.toolName;
		if (name !== "bash" && name !== "powershell") return undefined;

		const command = (event.input as { command?: unknown } | undefined)?.command;
		if (typeof command !== "string" || !command) return undefined;

		if (looksLikeFileDownload(command)) {
			return { block: true, reason: GUARD_HINT };
		}
		return undefined;
	});
}
