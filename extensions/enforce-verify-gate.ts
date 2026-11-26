/**
 * enforce-verify-gate.ts —— 收尾闸口：本轮改过文件，就必须见到 hud_verify
 *
 * 为什么需要它：hud_verify 只是「可调可不调」的工具，模型在任务目标占满注意力时会漏调，
 * 然后照样写出「已完成」。实测过：规则在上一轮刚读过仍会被违反，所以这不是提示词能修的。
 * 把"该不该验收"从模型的语义判断，换成工具调用记录这种可观测事实。
 *
 * 判据（纯规则，见 lib/verify-gate-logic.mjs）：
 *   最后一次写之后没有「带证据的 verified 项」的验收卡 → 在 agent_before_settle 追加提醒并强制再走一轮
 *   pending / blocked 不算通过；卡里有 failed 也不算。空卡、全 pending 卡都不放行。
 *
 * 边界：纯问答不拦｜每轮最多拦 1 次｜abort/error 不拦｜未注册 hud_verify 或 /hud off / verify off 时放行
 * 开关：PI_VERIFY_GATE=0 关闭；PI_VERIFY_GATE_DEBUG=<文件> 记录每次判定（供回归测试）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createGate } from "../lib/verify-gate-logic.mjs";

const HUD_CONFIG_PATH = process.env.PI_TOOL_HUD_CONFIG?.trim() || join(homedir(), ".pi", "agent", "tool-hud.json");

function isVerifyEnabledByHudConfig(): boolean {
	try {
		const raw = JSON.parse(readFileSync(HUD_CONFIG_PATH, "utf8"));
		if (raw?.mode === "off") return false;
		if (raw?.enforceVerify === false) return false;
	} catch {
		// 配置文件不存在或不可读时按默认开启处理
	}
	return true;
}

export default function enforceVerifyGate(pi: ExtensionAPI) {
	if (process.env.PI_VERIFY_GATE === "0") return;

	const debugPath = process.env.PI_VERIFY_GATE_DEBUG || null;
	const debug = (line: string) => {
		if (!debugPath) return;
		try {
			appendFileSync(debugPath, `${new Date().toISOString()} ${line}\n`);
		} catch {
			/* 调试落盘失败不影响主流程 */
		}
	};

	const gate = createGate();
	// 仅在用户发起的新一轮（或未标注 messageType 的标准起点）重置，避免内部提醒消息清空 nudged 状态
	pi.on("before_agent_start", (event: any) => {
		if (!event?.messageType || event.messageType === "user") gate.reset();
	});
	pi.on("session_start", () => gate.reset());

	pi.on("tool_result", (event) => {
		const name = String((event as any).toolName || "");
		const kind = gate.noteResult(name, (event as any).input ?? {}, Boolean((event as any).isError));
		if (kind) debug(`${kind}: ${name} ${JSON.stringify(gate.state)}`);
	});

	pi.on("agent_before_settle", (event: any, ctx: any) => {
		const outcome = event?.outcome ?? "completed";
		if (outcome !== "completed") {
			debug(`skip: outcome=${outcome}`);
			return;
		}
		if (!isVerifyEnabledByHudConfig()) {
			debug("allow: disabled by tool-hud.json");
			return;
		}
		if (!gate.shouldBlock()) {
			debug(`allow: ${JSON.stringify(gate.state)}`);
			return;
		}
		let hasHud = false;
		try {
			hasHud = (pi as any).getAllTools().some((t: any) => t?.name === "hud_verify");
		} catch {
			hasHud = false;
		}
		if (!hasHud) {
			debug("allow: hud_verify tool not registered");
			return;
		}
		gate.markNudged();
		debug(`NUDGE: ${JSON.stringify(gate.state)}`);
		try {
			ctx?.ui?.notify?.("⚠ 收尾闸口：本轮有改动但缺少有效 hud_verify 验收，已要求补验", "warning");
		} catch {
			/* UI 未就绪不影响拦截 */
		}
		return {
			continue: true,
			entries: [{ type: "custom_message" as const, customType: "verify-gate", display: false, content: gate.nudgeText() }],
		};
	});
}
