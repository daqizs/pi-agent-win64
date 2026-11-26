/**
 * ast-tools.ts —— 基于本机 ast-grep 的结构化搜索与「先预览、再落盘」AST 重写
 *
 * 借鉴 oh-my-pi 的 ast_grep / ast_edit 工作流：
 *   - ast_grep: 按语法树模式跨文件精准匹配代码结构（不误伤注释与字符串）
 *   - ast_edit: 默认 dryRun=true 先输出命中数、涉及文件与改写前后预览；
 *               确认无误后再以 dryRun=false 原子应用到磁盘。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";

const MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 40;

function resolveAstGrepBin(): string {
	const wingetPath =
		process.env.LOCALAPPDATA &&
		resolve(
			process.env.LOCALAPPDATA,
			"Microsoft",
			"WinGet",
			"Packages",
			"ast-grep.ast-grep_Microsoft.Winget.Source_8wekyb3d8bbwe",
			"ast-grep.exe",
		);
	if (wingetPath && existsSync(wingetPath)) return wingetPath;
	return "ast-grep";
}

function runAstGrep(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const bin = resolveAstGrepBin();
	return new Promise((res) => {
		execFile(bin, args, { cwd, maxBuffer: MAX_BUFFER, windowsHide: true }, (err, stdout, stderr) => {
			const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
			res({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

interface AstMatch {
	file: string;
	line: number;
	col: number;
	text: string;
	replacement?: string;
}

function parseJsonStream(stdout: string, cwd: string): AstMatch[] {
	const matches: AstMatch[] = [];
	for (const rawLine of stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || !line.startsWith("{")) continue;
		try {
			const obj = JSON.parse(line);
			const fileRaw = String(obj.file ?? "");
			const rel = fileRaw ? relative(cwd, resolve(cwd, fileRaw)).replace(/\\/g, "/") : fileRaw;
			matches.push({
				file: rel || fileRaw,
				line: Number(obj.range?.start?.line ?? 0) + 1,
				col: Number(obj.range?.start?.column ?? 0) + 1,
				text: String(obj.text ?? "").trim(),
				replacement: typeof obj.replacement === "string" ? obj.replacement.trim() : undefined,
			});
		} catch {
			// 跳过非 JSON 提示行
		}
	}
	return matches;
}

function oneLine(s: string, max = 100): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export default function astTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ast_grep",
		label: "AST 结构搜索",
		description:
			"基于 ast-grep (Tree-sitter) 按语法树结构搜索代码，支持元变量（如 $X、$$$ARGS），不会误匹配注释或字符串。",
		promptSnippet: "Structural AST code search via ast-grep (Tree-sitter patterns with $VAR / $$$ARGS)",
		parameters: Type.Object({
			pattern: Type.String({ description: "ast-grep 语法模式，例如 console.log($$$ARGS) 或 function $NAME($$$)" }),
			path: Type.Optional(Type.String({ description: "搜索目录或文件路径，默认当前目录" })),
			lang: Type.Optional(Type.String({ description: "语言名，如 ts / tsx / js / py / rust / go（单文件可省略）" })),
			maxResults: Type.Optional(Type.Number({ description: "最多返回条数，默认 40" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx?.cwd ?? process.cwd();
			const target = params.path?.trim() || ".";
			const maxResults = Math.max(1, Math.min(200, Number(params.maxResults ?? DEFAULT_MAX_RESULTS)));
			const args = ["run", "--pattern", params.pattern, "--json=stream"];
			if (params.lang?.trim()) args.push("--lang", params.lang.trim());
			args.push(target);

			const res = await runAstGrep(args, cwd);
			if (res.code !== 0 && !res.stdout.trim()) {
				const errMsg = res.stderr.trim() || `ast-grep exited with code ${res.code}`;
				return {
					isError: true,
					content: [{ type: "text" as const, text: `ast_grep 失败：${errMsg}` }],
				};
			}

			const matches = parseJsonStream(res.stdout, cwd);
			if (!matches.length) {
				return {
					content: [{ type: "text" as const, text: `No matches found for pattern: ${params.pattern}` }],
					details: { count: 0, files: 0 },
				};
			}

			const files = new Set(matches.map((m) => m.file));
			const shown = matches.slice(0, maxResults);
			const lines = shown.map((m) => `${m.file}:${m.line}:${m.col}  ${oneLine(m.text, 110)}`);
			if (matches.length > shown.length) {
				lines.push(`… 共命中 ${matches.length} 处（涉及 ${files.size} 个文件），仅展示前 ${shown.length} 处`);
			} else {
				lines.push(`共命中 ${matches.length} 处（涉及 ${files.size} 个文件）`);
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { count: matches.length, files: files.size },
			};
		},
	});

	pi.registerTool({
		name: "ast_edit",
		label: "AST 结构重写",
		description:
			"基于 ast-grep 的跨文件结构化代码重写。默认 dryRun=true 先输出命中数与改写前后预览（不改磁盘）；确认后再以 dryRun=false 原子应用。",
		promptSnippet: "Structural AST rewrite with preview-first dryRun=true (default) and atomic apply dryRun=false",
		promptGuidelines: [
			"跨文件批量重构或按语法结构替换代码时，优先用 ast_edit：第一次务必保持 dryRun=true 预览命中数与前后对照，确认无误后再传 dryRun=false 真正写入。",
		],
		parameters: Type.Object({
			pattern: Type.String({ description: "匹配的 ast-grep 语法模式，如 console.log($X)" }),
			rewrite: Type.String({ description: "替换后的语法模式，如 logger.debug($X)" }),
			path: Type.Optional(Type.String({ description: "目标目录或文件，默认当前目录" })),
			lang: Type.Optional(Type.String({ description: "语言名，如 ts / tsx / js / py / rust / go" })),
			dryRun: Type.Optional(Type.Boolean({ description: "是否仅预览不写入磁盘，默认 true；传 false 时原子落盘" })),
			maxPreview: Type.Optional(Type.Number({ description: "预览最多展示几处改写，默认 20" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx?.cwd ?? process.cwd();
			const target = params.path?.trim() || ".";
			const dryRun = params.dryRun !== false;
			const maxPreview = Math.max(1, Math.min(100, Number(params.maxPreview ?? 20)));

			// 无论预览还是应用，先跑一次 JSON 流拿精确命中数与涉及文件清单
			const previewArgs = ["run", "--pattern", params.pattern, "--rewrite", params.rewrite, "--json=stream"];
			if (params.lang?.trim()) previewArgs.push("--lang", params.lang.trim());
			previewArgs.push(target);

			const previewRes = await runAstGrep(previewArgs, cwd);
			if (previewRes.code !== 0 && !previewRes.stdout.trim()) {
				const errMsg = previewRes.stderr.trim() || `ast-grep exited with code ${previewRes.code}`;
				return {
					isError: true,
					content: [{ type: "text" as const, text: `ast_edit 失败：${errMsg}` }],
				};
			}

			const matches = parseJsonStream(previewRes.stdout, cwd);
			if (!matches.length) {
				return {
					content: [{ type: "text" as const, text: `未找到可重写的匹配项（pattern: ${params.pattern}）` }],
					details: { mode: dryRun ? "proposed" : "applied", count: 0, files: 0 },
				};
			}

			const files = [...new Set(matches.map((m) => m.file))];

			if (dryRun) {
				const head = `[PROPOSED] 预计重写 ${matches.length} 处（涉及 ${files.length} 个文件，尚未写入磁盘）：`;
				const body = matches
					.slice(0, maxPreview)
					.map((m) => `- ${m.file}:${m.line}  ${oneLine(m.text, 60)}  →  ${oneLine(m.replacement ?? params.rewrite, 60)}`);
				if (matches.length > maxPreview) body.push(`… 另有 ${matches.length - maxPreview} 处未展开`);
				body.push("确认无误后，再次调用 ast_edit 并传入 dryRun: false 原子落盘。");
				return {
					content: [{ type: "text" as const, text: [head, ...body].join("\n") }],
					details: { mode: "proposed", count: matches.length, files: files.length },
				};
			}

			const applyArgs = ["run", "--pattern", params.pattern, "--rewrite", params.rewrite, "--update-all"];
			if (params.lang?.trim()) applyArgs.push("--lang", params.lang.trim());
			applyArgs.push(target);

			const applyRes = await runAstGrep(applyArgs, cwd);
			if (applyRes.code !== 0) {
				const errMsg = applyRes.stderr.trim() || `ast-grep --update-all exited with code ${applyRes.code}`;
				return {
					isError: true,
					content: [{ type: "text" as const, text: `ast_edit 落盘失败：${errMsg}` }],
				};
			}

			const head = `[APPLIED] 已原子重写 ${matches.length} 处（${files.length} 个文件）：`;
			const fileList = files.slice(0, 20).map((f) => `- ${f}`);
			if (files.length > 20) fileList.push(`… 等共 ${files.length} 个文件`);
			return {
				content: [{ type: "text" as const, text: [head, ...fileList].join("\n") }],
				details: { mode: "applied", count: matches.length, files: files.length },
			};
		},
	});
}
