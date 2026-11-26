/**
 * advisor-review.ts —— 按需独立强模型红队审阅（/advisor）
 *
 * 借鉴 oh-my-pi 的 Advisor 角色，但改为「按需手动触发」更省额度：
 *   - 执行 `/advisor`（或 `/advisor opus`、`/advisor pro`、`/advisor opus 重点查并发`）
 *   - 自动提取当前工作区 `git status --short` 与 `git diff`（优先含暂存+未暂存，封顶 16KB）
 *   - 临时将本轮模型切为强审阅模型（默认 codecraft/claude-opus-5，回退 wbk/cn:deepseek-v4-pro）并拉高思考强度
 *   - 仅做只读红队审阅（P0–P3 分级挑刺），审阅结束后自动恢复原模型与思考强度。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { splitModelSpec } from "../lib/smart-router-logic.mjs";

const ADVISOR_ALIASES: Record<string, string> = {
	opus: "codecraft/claude-opus-5",
	pro: "wbk/cn:deepseek-v4-pro",
	flash: "wbk/cn:deepseek-v4.1-flash",
};

const DEFAULT_FALLBACK_ORDER = ["codecraft/claude-opus-5", "wbk/cn:deepseek-v4-pro"];
const MAX_DIFF_CHARS = 16_000;

function findModel(ctx: any, spec: string): any | undefined {
	const parsed = splitModelSpec(spec);
	if (!parsed) return undefined;
	const registry = ctx?.modelRegistry;
	if (!registry) return undefined;
	if (typeof registry.find === "function") {
		const hit = registry.find(parsed.provider, parsed.modelId);
		if (hit) return hit;
	}
	if (typeof registry.getAll === "function") {
		const all = registry.getAll();
		if (Array.isArray(all)) {
			return all.find((m: any) => m?.provider === parsed.provider && m?.id === parsed.modelId);
		}
	}
	return undefined;
}

export default function advisorReview(pi: ExtensionAPI) {
	let restoreState: { prevModel?: any; prevThinking?: any } | null = null;

	async function restore(ctx?: any) {
		const snap = restoreState;
		restoreState = null;
		if (!snap) return;
		try {
			if (snap.prevModel) await pi.setModel(snap.prevModel);
		} catch {
			// 忽略恢复失败
		}
		try {
			if (snap.prevThinking !== undefined) pi.setThinkingLevel(snap.prevThinking);
		} catch {
			// 忽略恢复失败
		}
		try {
			if (ctx?.hasUI) ctx.ui.setStatus("advisor-review", undefined);
		} catch {
			// 忽略清理失败
		}
	}

	pi.on("agent_settled", async (_event: any, ctx: any) => restore(ctx));
	pi.on("session_start", async (_event: any, ctx: any) => restore(ctx));
	pi.on("session_shutdown", async () => restore());

	pi.registerCommand("advisor", {
		description: "按需独立强模型红队审阅当前 git diff：/advisor [opus|pro] [重点关注说明]",
		handler: async (arg, ctx) => {
			const tokens = String(arg ?? "").trim().split(/\s+/).filter(Boolean);
			let requestedAlias = "";
			let focusNote = "";
			if (tokens[0] && ADVISOR_ALIASES[tokens[0].toLowerCase()]) {
				requestedAlias = tokens[0].toLowerCase();
				focusNote = tokens.slice(1).join(" ");
			} else {
				focusNote = tokens.join(" ");
			}

			const repoCheck = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
			if (repoCheck.code !== 0) {
				ctx.ui.notify("advisor: 当前目录不是 Git 仓库，无法自动采集 diff（可直接在对话里用 @opus 审阅）", "warning");
				return;
			}

			const [statusRes, unstagedRes, stagedRes] = await Promise.all([
				pi.exec("git", ["status", "--short"]),
				pi.exec("git", ["diff"]),
				pi.exec("git", ["diff", "--cached"]),
			]);

			const combinedDiff = [
				stagedRes.stdout?.trim() ? `### Staged Diff\n\`\`\`diff\n${stagedRes.stdout.trim()}\n\`\`\`` : "",
				unstagedRes.stdout?.trim() ? `### Unstaged Diff\n\`\`\`diff\n${unstagedRes.stdout.trim()}\n\`\`\`` : "",
			]
				.filter(Boolean)
				.join("\n\n");

			if (!combinedDiff && !statusRes.stdout?.trim()) {
				ctx.ui.notify("advisor: 工作区干净，没有未提交的改动需要审阅", "info");
				return;
			}

			const diffSnippet =
				combinedDiff.length > MAX_DIFF_CHARS
					? `${combinedDiff.slice(0, MAX_DIFF_CHARS)}\n\n... [diff 已截断，原长 ${combinedDiff.length} 字符，必要时可用 read/bash 抽查具体文件]`
					: combinedDiff || "（仅有未跟踪文件，见上方 git status）";

			const candidates = requestedAlias ? [ADVISOR_ALIASES[requestedAlias]!] : DEFAULT_FALLBACK_ORDER;
			let targetSpec = "";
			let targetModel: any;
			for (const spec of candidates) {
				const m = findModel(ctx, spec);
				if (m) {
					targetSpec = spec;
					targetModel = m;
					break;
				}
			}

			const snap: { prevModel?: any; prevThinking?: any } = {};
			if (targetModel && ctx.model !== targetModel) {
				snap.prevModel = ctx.model;
				try {
					await pi.setModel(targetModel);
				} catch {
					targetSpec = "";
				}
			}
			try {
				const prevThink = pi.getThinkingLevel();
				if (prevThink !== "high") {
					snap.prevThinking = prevThink;
					pi.setThinkingLevel("high");
				}
			} catch {
				// 忽略不支持思考等级的模型
			}

			if (snap.prevModel || snap.prevThinking !== undefined) {
				restoreState = snap;
				const label = targetSpec || "当前模型";
				ctx.ui.notify(`🔍 Advisor 红队审阅已启动（${label} · thinking:high，审阅完自动恢复）`, "info");
				if (ctx.hasUI) ctx.ui.setStatus("advisor-review", `🔍 Advisor: ${label}`);
			}

			const prompt = [
				"你现在作为独立红队审阅者（Advisor），只做只读代码审阅，**严禁修改任何文件**。",
				focusNote ? `用户特别关注：${focusNote}` : "",
				"请严格按 **P0（阻断/数据丢失/安全）→ P1（逻辑漏洞/回归）→ P2（边界/健壮性）** 分级指出真实问题，每条给清「文件:行号 + 触发路径 + 修复建议」，最后明确给出「可发布 / 需修复后再发布」结论；没有问题就直说通过，不要凑数。",
				`### git status --short\n\`\`\`\n${(statusRes.stdout || "").trim() || "(empty)"}\n\`\`\``,
				diffSnippet,
			]
				.filter(Boolean)
				.join("\n\n");

			pi.sendUserMessage(prompt);
		},
	});
}
