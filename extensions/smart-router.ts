/**
 * smart-router.ts —— 提示词魔术词路由（ultrathink / chillax / @opus / @pro / @flash）
 *
 * 借鉴 oh-my-pi 的 Magic keywords 与模型角色路由：
 *   - 在提问正文里写 `ultrathink` → 本轮自动拉高思考强度为 high
 *   - 在提问正文里写 `chillax`    → 本轮自动降为 off（快速直出）
 *   - 在提问正文里写 `@opus` / `@pro` / `@flash` → 本轮临时切换对应模型
 *   - 本轮结束（agent_settled）自动恢复到切换前的模型与思考强度，不污染下一轮。
 *
 * 配置文件：~/.pi/agent/smart-router.json（首次自动生成，可随时增删别名）
 * 命令行：  /route | /route on | /route off | /route reload
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_ROUTER_CONFIG, parseRouteDirective, splitModelSpec } from "../lib/smart-router-logic.mjs";

const CONFIG_PATH =
	process.env.PI_SMART_ROUTER_CONFIG?.trim() || join(homedir(), ".pi", "agent", "smart-router.json");

interface RouterConfig {
	enabled: boolean;
	aliases: Record<string, string>;
	thinkingKeywords: Record<string, string>;
}

function loadRouterConfig(): RouterConfig {
	try {
		if (!existsSync(CONFIG_PATH)) {
			mkdirSync(dirname(CONFIG_PATH), { recursive: true });
			writeFileSync(CONFIG_PATH, `${JSON.stringify(DEFAULT_ROUTER_CONFIG, null, 2)}\n`, "utf8");
			return { ...DEFAULT_ROUTER_CONFIG };
		}
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		return {
			enabled: raw?.enabled !== false,
			aliases: { ...DEFAULT_ROUTER_CONFIG.aliases, ...(raw?.aliases ?? {}) },
			thinkingKeywords: { ...DEFAULT_ROUTER_CONFIG.thinkingKeywords, ...(raw?.thinkingKeywords ?? {}) },
		};
	} catch {
		return { ...DEFAULT_ROUTER_CONFIG };
	}
}

function saveRouterConfig(cfg: RouterConfig): void {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
	} catch {
		// 写入失败不影响当前会话
	}
}

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

export default function smartRouter(pi: ExtensionAPI) {
	if (process.env.PI_SMART_ROUTER === "0") return;

	let cfg = loadRouterConfig();
	let pendingRestore: { prevModel?: any; prevThinking?: any } | null = null;

	async function restoreIfNeeded(ctx?: any) {
		const snap = pendingRestore;
		pendingRestore = null;
		if (!snap) return;
		try {
			if (snap.prevModel) await pi.setModel(snap.prevModel);
		} catch {
			// 恢复模型失败不抛异常
		}
		try {
			if (snap.prevThinking !== undefined) pi.setThinkingLevel(snap.prevThinking);
		} catch {
			// 恢复思考强度失败不抛异常
		}
		try {
			if (ctx?.hasUI) ctx.ui.setStatus("smart-router", undefined);
		} catch {
			// 忽略 UI 清理失败
		}
	}

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		if (!cfg.enabled) return;
		if (event?.messageType !== "user") return;
		const prompt = String(event?.prompt ?? "");
		if (!prompt.trim()) return;

		const dir = parseRouteDirective(prompt, cfg);
		if (!dir.modelSpec && !dir.thinkingLevel) return;

		const restore: { prevModel?: any; prevThinking?: any } = {};
		const notes: string[] = [];

		if (dir.modelSpec) {
			const targetModel = findModel(ctx, dir.modelSpec);
			if (targetModel && ctx?.model !== targetModel) {
				restore.prevModel = ctx?.model;
				try {
					const ok = await pi.setModel(targetModel);
					if (ok) notes.push(`${dir.alias} → ${dir.modelSpec}`);
				} catch {
					// 模型不可用时保持原模型
				}
			}
		}

		if (dir.thinkingLevel) {
			try {
				const prev = pi.getThinkingLevel();
				if (prev !== dir.thinkingLevel) {
					restore.prevThinking = prev;
					pi.setThinkingLevel(dir.thinkingLevel as any);
					notes.push(`${dir.keyword} → thinking:${dir.thinkingLevel}`);
				}
			} catch {
				// 不支持切换思考强度时忽略
			}
		}

		if (notes.length) {
			pendingRestore = restore;
			const badge = `⚡ 临时路由：${notes.join(" · ")}（本轮结束自动恢复）`;
			try {
				ctx?.ui?.notify?.(badge, "info");
				if (ctx?.hasUI) ctx.ui.setStatus("smart-router", `⚡ ${notes.join(" · ")}`);
			} catch {
				// 忽略 UI 提示失败
			}
		}
	});

	pi.on("agent_settled", async (_event: any, ctx: any) => {
		await restoreIfNeeded(ctx);
	});
	pi.on("session_start", async (_event: any, ctx: any) => {
		await restoreIfNeeded(ctx);
	});
	pi.on("session_shutdown", async () => {
		await restoreIfNeeded();
	});

	pi.registerCommand("route", {
		description: "智能词控路由（ultrathink / chillax / @opus / @pro / @flash）：/route [on|off|reload]",
		handler: async (arg, ctx) => {
			const sub = String(arg ?? "").trim().toLowerCase();
			if (sub === "on" || sub === "off") {
				cfg = { ...cfg, enabled: sub === "on" };
				saveRouterConfig(cfg);
				ctx.ui.notify(`smart-router: ${cfg.enabled ? "已开启" : "已关闭"}`, "info");
				return;
			}
			if (sub === "reload") {
				cfg = loadRouterConfig();
				ctx.ui.notify("smart-router: 已重载配置", "info");
				return;
			}
			const aliasText = Object.entries(cfg.aliases)
				.map(([k, v]) => `  @${k} → ${v}`)
				.join("\n");
			const kwText = Object.entries(cfg.thinkingKeywords)
				.map(([k, v]) => `  ${k} → thinking:${v}`)
				.join("\n");
			ctx.ui.notify(
				`smart-router: ${cfg.enabled ? "开启" : "关闭"}\n模型别名：\n${aliasText}\n思考词控：\n${kwText}\n用法：/route on | off | reload`,
				"info",
			);
		},
	});
}
