/**
 * verify-gate-logic.mjs —— 收尾闸口的纯逻辑（无 pi 依赖，可单测）
 *
 * 判据只看工具调用记录，不解析模型措辞：
 *   - 发生过写操作，且**最后一次写之后**没有「带有效证据的验收卡」→ 该拦
 *   - 验收卡存在但不等于通过：pending / blocked 不算通过，failed 更不算
 *   - 顺序用单调 seq 判定，所以"先验证后写"不算数
 *   - 每轮只拦一次（nudged），避免死循环
 */
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch"]);

// 只认命令位置上的写入型命令；引号内容与 heredoc 正文先抹掉，避免 grep "rm x" 误判
// 带 /im：兼容多行命令（\n 分隔）和 PowerShell 大小写不敏感
const MUTATING =
	/(?:^|[\n;&|({]\s*)(rm|rmdir|mv|cp|mkdir|touch|tee|chmod|chown|ln|truncate|dd|patch|remove-item|ri|del|set-content|add-content|out-file|clear-content|new-item|copy-item|move-item|rename-item)\b|(?:^|[\n;&|({]\s*)sed\b[^\n;|&]*\s(?:-i|--in-place)\b|(?:^|[\n;&|({]\s*)perl\b[^\n;|&]*\s-[a-z]*i\b|\bgit\s+(?:add|commit|checkout|restore|reset|clean|apply|am|rm|stash|switch|merge|rebase)\b|\b(?:npm|pnpm|yarn|bun|pip3?|apt|apt-get|brew|winget|choco)\s+(?:i|install|add|uninstall|remove|upgrade)\b|\b(?:curl|wget)\b[^\n;|&]*\s(?:-o|-O|--output)\b/im;

export function stripQuoted(cmd) {
	return String(cmd)
		.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1/g, " ")
		.replace(/'[^']*'/g, "''")
		.replace(/"[^"]*"/g, '""');
}

export function looksLikeWrite(toolName, input) {
	if (WRITE_TOOLS.has(toolName)) return true;
	// ast_edit 只有在 dryRun === false 时才真正落盘（默认 dryRun=true 仅预览）
	if (toolName === "ast_edit") return input?.dryRun === false;
	if (toolName !== "bash" && toolName !== "powershell") return false;
	const cmd = String((input && (input.command ?? input.cmd)) || "");
	if (!cmd) return false;
	const stripped = stripQuoted(cmd);
	// 先抹掉无害重定向（/dev/null、PowerShell $null、Windows NUL、fd 复制如 2>&1 / >&2）
	const cleaned = stripped
		.replace(/(?:[0-9]*&?)?>>?\s*(?:\/dev\/null|\$null\b|nul\b)/gi, " ")
		.replace(/[0-9]*>&[0-9]+/g, " ");
	// 重定向写文件：> / >> / 1> / 2> / &> 都算；排除 => 与 ->
	const redirect = /(?:^|[^=-])>>?\s*[^\s&>|;)]/.test(cleaned);
	return redirect || MUTATING.test(stripped);
}

/**
 * 验收卡的「证据门禁」判定。
 *   pass        至少 1 条 verified 且带证据，且没有 failed —— 才允许作为完成依据
 *   no_evidence 有卡但没有任何带证据的 verified（全 pending / blocked / 仅声称）
 *   failure     卡里明确有 failed 项
 * pending 与 blocked 都不算通过：前者是还没验证，后者是外部条件不允许验证。
 */
export function cardVerdict(input) {
	const items = Array.isArray(input?.items) ? input.items : [];
	const counts = { pass: 0, fail: 0, pending: 0, blocked: 0, unsupported: 0 };
	for (const item of items) {
		const state = String(item?.state ?? "");
		const evidence = String(item?.evidence ?? "").trim();
		if (state === "verified") {
			if (evidence) counts.pass++;
			else counts.unsupported++;
		} else if (state === "failed") counts.fail++;
		else if (state === "blocked") counts.blocked++;
		else counts.pending++;
	}
	const verdict = counts.fail > 0 ? "failure" : counts.pass > 0 ? "pass" : "no_evidence";
	return { verdict, counts };
}

export function createGate() {
	let writes = 0;
	let verifies = 0;
	let passCards = 0;
	let lastWrite = -1;
	let lastPass = -1;
	let lastVerdict = null;
	let seq = 0;
	let nudged = false;

	return {
		noteResult(toolName, input, isError) {
			if (toolName === "hud_verify") {
				if (!isError) {
					verifies++;
					const { verdict } = cardVerdict(input || {});
					lastVerdict = verdict;
					if (verdict === "pass") {
						passCards++;
						lastPass = seq;
					}
					seq++;
				}
				return "verify";
			}
			if (looksLikeWrite(toolName, input || {})) {
				// 纯文件写入工具（write/edit/apply_patch）自身报错表示未落盘，不记为写操作；
				// shell 命令报错仍可能已产生部分副作用，保守计入。
				if (isError && WRITE_TOOLS.has(toolName)) return null;
				writes++;
				lastWrite = seq++;
				return "write";
			}
			return null;
		},
		shouldBlock() {
			return lastWrite >= 0 && lastWrite > lastPass && !nudged;
		},
		/** 拦截时要对模型说的话：区分「验收后又改过」「根本没验收」「验收了但卡不成立」 */
		nudgeText() {
			if (lastPass >= 0 && lastWrite > lastPass) {
				return (
					"【收尾闸口】本轮上次验收通过之后又发生过新的写操作，之前的验收结果已过期。" +
					"请针对最新改动重新调用 hud_verify 声明验收状态（verified 必须附最新实测证据），再给结论。"
				);
			}
			if (lastVerdict === "failure") {
				return (
					"【收尾闸口】本轮验收卡里有 failed 项，不能把任务写成完成。" +
					"修完重测并把对应项改成 verified（附实测证据），或在结论里明确写「未完成 + 卡在哪」。"
				);
			}
			if (verifies > 0) {
				return (
					"【收尾闸口】本轮调过 hud_verify，但那张卡不能作为完成依据：" +
					"没有任何一条 verified 带证据（pending / blocked / 仅声称都不算通过）。" +
					"补实测证据（命令、退出码、文件:行号），或说明为什么只能 pending / blocked。"
				);
			}
			return (
				"【收尾闸口】本轮发生过写操作，但没有成功的 hud_verify 记录。" +
				"先调用 hud_verify 逐条声明验收状态（verified 必须附命令/文件:行号/实测值；靠推理的写 pending；" +
				"外部条件不允许验证写 blocked；实测不符写 failed），再给结论。" +
				"没有可验收项时，明确说明本轮只是问答、不做完成声明。"
			);
		},
		markNudged() {
			nudged = true;
		},
		reset() {
			writes = 0;
			verifies = 0;
			passCards = 0;
			lastWrite = -1;
			lastPass = -1;
			lastVerdict = null;
			seq = 0;
			nudged = false;
		},
		get state() {
			return { writes, verifies, passCards, lastWrite, lastPass, lastVerdict, nudged };
		},
	};
}
