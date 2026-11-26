/**
 * smart-router-logic.mjs —— 提示词魔术词与模型别名路由纯逻辑
 *
 * 仅在普通自然语言文本中匹配，跳过围栏代码块、行内代码与 URL/路径，避免误触发：
 *   - ultrathink  → 本轮思考强度切为 high
 *   - chillax     → 本轮思考强度切为 off
 *   - @opus       → 本轮模型临时切为 codecraft/claude-opus-5
 *   - @pro        → 本轮模型临时切为 wbk/cn:deepseek-v4-pro
 *   - @flash      → 本轮模型临时切为 wbk/cn:deepseek-v4.1-flash
 */

export const DEFAULT_ROUTER_CONFIG = {
	enabled: true,
	aliases: {
		flash: "wbk/cn:deepseek-v4.1-flash",
		pro: "wbk/cn:deepseek-v4-pro",
		opus: "codecraft/claude-opus-5",
	},
	thinkingKeywords: {
		ultrathink: "high",
		chillax: "off",
	},
};

/** 去掉围栏代码块、行内代码与常见邮箱/URL，只保留自然语言部分 */
export function stripCodeForRouting(prompt) {
	return String(prompt ?? "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/~~~[\s\S]*?~~~/g, " ")
		.replace(/`[^`\n]+`/g, " ")
		.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, " ")
		.replace(/https?:\/\/\S+/g, " ");
}

/**
 * 解析一条用户提示词是否触发临时模型或思考强度路由。
 * 返回 { modelSpec?: string, alias?: string, thinkingLevel?: string, keyword?: string }
 */
export function parseRouteDirective(prompt, cfg = DEFAULT_ROUTER_CONFIG) {
	if (!cfg || cfg.enabled === false) return {};
	const text = stripCodeForRouting(prompt);
	const out = {};

	const keywords = cfg.thinkingKeywords ?? DEFAULT_ROUTER_CONFIG.thinkingKeywords;
	for (const [kw, level] of Object.entries(keywords)) {
		if (!kw || !level) continue;
		const re = new RegExp(`(?:^|[\\s，。！？、,;:(（])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s，。！？、,;:）)])`);
		if (re.test(text)) {
			out.thinkingLevel = String(level);
			out.keyword = kw;
			break;
		}
	}

	const aliases = cfg.aliases ?? DEFAULT_ROUTER_CONFIG.aliases;
	for (const [alias, spec] of Object.entries(aliases)) {
		if (!alias || !spec) continue;
		const re = new RegExp(`(?:^|[\\s，。！？、,;:(（])@${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s，。！？、,;:）)])`, "i");
		if (re.test(text)) {
			out.modelSpec = String(spec);
			out.alias = `@${alias}`;
			break;
		}
	}

	return out;
}

export function splitModelSpec(spec) {
	const s = String(spec ?? "").trim();
	const idx = s.indexOf("/");
	if (idx <= 0 || idx === s.length - 1) return null;
	return { provider: s.slice(0, idx), modelId: s.slice(idx + 1) };
}
