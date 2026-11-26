/**
 * ttsr-guard.ts —— 轻量版按需触发纠偏规则（TTSR）
 *
 * 借鉴 oh-my-pi 的 Time-Traveling Stream Rules 思路：
 * 低频硬规则平时不塞进系统提示词（零 token 占用），
 * 只有当 tool_call 踩中红线正则时才当场拦截并注入修复指引，让模型原地纠正。
 *
 * 配置文件：~/.pi/agent/ttsr-rules.json（首次自动生成，可随时编辑）
 * 命令行：  /ttsr | /ttsr on | /ttsr off | /ttsr reload
 * 环境变量：PI_TTSR_GUARD=0 临时关闭
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_TTSR_RULES, evaluateTtsr } from "../lib/ttsr-logic.mjs";

const RULES_PATH = process.env.PI_TTSR_RULES_PATH?.trim() || join(homedir(), ".pi", "agent", "ttsr-rules.json");

interface TtsrConfig {
	enabled: boolean;
	rules: any[];
}

function loadTtsrConfig(): TtsrConfig {
	try {
		if (!existsSync(RULES_PATH)) {
			const initial: TtsrConfig = { enabled: true, rules: DEFAULT_TTSR_RULES };
			mkdirSync(dirname(RULES_PATH), { recursive: true });
			writeFileSync(RULES_PATH, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
			return initial;
		}
		const raw = JSON.parse(readFileSync(RULES_PATH, "utf8"));
		return {
			enabled: raw?.enabled !== false,
			rules: Array.isArray(raw?.rules) ? raw.rules : DEFAULT_TTSR_RULES,
		};
	} catch {
		return { enabled: true, rules: DEFAULT_TTSR_RULES };
	}
}

function saveTtsrConfig(cfg: TtsrConfig): void {
	try {
		mkdirSync(dirname(RULES_PATH), { recursive: true });
		writeFileSync(RULES_PATH, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
	} catch {
		// 写入失败不影响当前会话运行
	}
}

export default function ttsrGuard(pi: ExtensionAPI) {
	if (process.env.PI_TTSR_GUARD === "0") return;

	let cfg = loadTtsrConfig();
	const hits = new Map<string, number>();

	pi.on("tool_call", (event, ctx) => {
		if (!cfg.enabled) return;
		const res = evaluateTtsr(event.toolName, (event as any).input ?? {}, cfg.rules);
		if (!res.block) return;

		const ruleId = String(res.ruleId || "unknown");
		hits.set(ruleId, (hits.get(ruleId) ?? 0) + 1);
		try {
			ctx?.ui?.notify?.(`⚡ TTSR 拦截 [${ruleId}]：已引导模型按规范重写`, "warning");
		} catch {
			// UI 未就绪不影响拦截
		}
		return { block: true, reason: res.reason };
	});

	pi.registerCommand("ttsr", {
		description: "按需纠偏规则（TTSR）：/ttsr [on|off|reload]",
		handler: async (arg, ctx) => {
			const sub = String(arg ?? "").trim().toLowerCase();
			if (sub === "on" || sub === "off") {
				cfg = { ...cfg, enabled: sub === "on" };
				saveTtsrConfig(cfg);
				ctx.ui.notify(`ttsr-guard: ${cfg.enabled ? "已开启" : "已关闭"}`, "info");
				return;
			}
			if (sub === "reload") {
				cfg = loadTtsrConfig();
				ctx.ui.notify(`ttsr-guard: 已重载 ${cfg.rules.length} 条规则`, "info");
				return;
			}
			const active = cfg.rules.filter((r) => r?.enabled !== false).length;
			const summary = cfg.rules
				.map((r) => `  - ${r.id} (${r.enabled === false ? "关" : "开"}, 命中 ${hits.get(r.id) ?? 0})`)
				.join("\n");
			ctx.ui.notify(
				`ttsr-guard: ${cfg.enabled ? "开启" : "关闭"} · 生效 ${active}/${cfg.rules.length} 条\n${summary}\n用法：/ttsr on | off | reload`,
				"info",
			);
		},
	});
}
