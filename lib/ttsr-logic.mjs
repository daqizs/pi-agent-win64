/**
 * ttsr-logic.mjs —— 轻量版按需触发纠偏规则（TTSR）纯逻辑
 *
 * 规则平时零 token 休眠，只在 tool_call 踩中红线时实时拦截并注入修复指引。
 * 与 security-guard.ts 互补：security-guard 负责高危破坏/凭据泄露，
 * ttsr-guard 负责 AGENTS.md 里的编码、Windows/PowerShell、下载与操作规范。
 */

export const DEFAULT_TTSR_RULES = [
	{
		id: "no-sed-awk-edit",
		enabled: true,
		tools: ["bash", "powershell"],
		field: "command",
		pattern: "(?:^|[\\n;&|({]\\s*)(?:sed\\b[^\\n;|&]*\\s(?:-i|--in-place)|awk\\b[^\\n;|&]*-i\\s+inplace|perl\\b[^\\n;|&]*\\s-[a-z]*i\\b)",
		flags: "im",
		message:
			"【TTSR 规范纠偏】禁止用 sed -i / awk / perl -i 直接改文件。请改用内置 edit（hashline 精准编辑）或 ast_edit（结构化预览重写），并在改完后 read 验证。",
	},
	{
		id: "no-echo-append-code",
		enabled: true,
		tools: ["bash", "powershell"],
		field: "command",
		pattern: "(?:^|[\\n;&|({]\\s*)(?:echo|printf)\\b[^\\n;|&]*>>\\s*['\"]?[^\\s'\"]+\\.(?:ts|tsx|js|mjs|cjs|json|py|md|ps1|bat|cmd)\\b",
		flags: "im",
		message:
			"【TTSR 规范纠偏】禁止用 echo >> 向代码/脚本/配置文件追加内容（易破坏结构或编码）。请改用 edit 或 write 工具。",
	},
	{
		id: "curl-must-fail-fast",
		enabled: true,
		tools: ["bash", "powershell"],
		field: "command",
		pattern: "(?:^|[\\n;&|({]\\s*)curl(?:\\.exe)?\\b(?![^\\n;|&]*(?:\\s-[a-zA-Z]*f|\\s--fail\\b))[^\\n;|&]*(?:\\s(?:-o|-O|--output)\\b)",
		flags: "im",
		message:
			"【TTSR 规范纠偏】用 curl 下载保存文件必须带 -f（推荐 curl -fsSL），避免把 404/500 错误页面静默保存成损坏文件。",
	},
	{
		id: "no-blind-chrome-kill",
		enabled: true,
		tools: ["bash", "powershell"],
		field: "command",
		pattern: "(?:taskkill\\b[^\\n;|&]*chrome\\.exe|stop-process\\b[^\\n;|&]*chrome)",
		flags: "im",
		message:
			"【TTSR 规范纠偏】禁止直接强杀用户主 Chrome 浏览器进程（可能丢失未保存标签页）。如需无头或隔离实例，请使用临时 --user-data-dir 启动，或先获得用户明确授权。",
	},
	{
		id: "ps1-utf8-bom-or-ascii",
		enabled: true,
		tools: ["write"],
		pathPattern: "\\.ps1$",
		field: "content",
		check: "ps1_non_ascii_without_bom",
		message:
			"【TTSR 规范纠偏】写入的 .ps1 脚本包含中文/非 ASCII 字符但缺少 UTF-8 BOM（\\uFEFF），在 Windows PowerShell 5.1 下可能触发 GBK 解析截断。请改为纯 ASCII 或在文件开头加 UTF-8 BOM。",
	},
];

export function evaluateTtsr(toolName, input, rules = DEFAULT_TTSR_RULES) {
	const name = String(toolName || "").toLowerCase();
	const args = input && typeof input === "object" ? input : {};
	const targetPath = String(args.path ?? args.file_path ?? args.filePath ?? "");

	for (const rule of rules) {
		if (!rule || rule.enabled === false) continue;
		const tools = Array.isArray(rule.tools) ? rule.tools.map((t) => String(t).toLowerCase()) : [];
		if (tools.length && !tools.includes(name)) continue;

		if (rule.pathPattern) {
			try {
				if (!new RegExp(rule.pathPattern, "i").test(targetPath)) continue;
			} catch {
				continue;
			}
		}

		const fieldName = rule.field || (name === "bash" || name === "powershell" ? "command" : "content");
		const value = String(args[fieldName] ?? (fieldName === "command" ? args.cmd ?? "" : ""));
		if (!value) continue;

		if (rule.check === "ps1_non_ascii_without_bom") {
			const hasNonAscii = /[^\x00-\x7F]/.test(value);
			const hasBom = value.charCodeAt(0) === 0xfeff;
			if (hasNonAscii && !hasBom) {
				return { block: true, ruleId: rule.id, reason: rule.message };
			}
			continue;
		}

		if (rule.pattern) {
			try {
				const re = new RegExp(rule.pattern, rule.flags || "im");
				if (re.test(value)) {
					return { block: true, ruleId: rule.id, reason: rule.message };
				}
			} catch {
				// 忽略格式错误的用户自定义正则，不阻塞主流程
			}
		}
	}

	return { block: false };
}
