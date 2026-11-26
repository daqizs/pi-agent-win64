/**
 * patch-check-status.mjs —— 把逐项补丁状态归成三态（纯函数，可单测）
 *
 *   pass         全部已打补丁 —— 只有这一态能作为「补丁验收成功」的依据
 *   needs_action 有明确可处理的状态（原始 / 半新半旧）—— 可自动重打或需人工确认
 *   error        无法判断：片段不匹配、目标文件缺失、检查项为空 —— 不能当成「没打补丁」
 *
 * 为什么必须分开：旧实现里「未知」与「原始」都靠中文文案判断，
 * 一旦脚本执行异常（输出为空），既不匹配「原始状态」也不匹配「未知」，
 * 就被静默当成「不需要处理」—— 升级后补丁其实没适配也看不出来。
 */
export const PATCH_STATUS = {
	PASS: "pass",
	NEEDS_ACTION: "needs_action",
	ERROR: "error",
};

const PROCESSABLE = new Set(["original", "mixed"]);
const UNJUDGEABLE = new Set(["unknown", "missing"]);

export function classifyPatches(records) {
	if (!Array.isArray(records) || records.length === 0) {
		return { status: PATCH_STATUS.ERROR, reason: "没有检查项", blockers: [] };
	}
	const blockers = records.filter((r) => UNJUDGEABLE.has(r?.state));
	if (blockers.length) {
		const names = blockers.map((r) => `${r.id}/${r.target}`).join(", ");
		return { status: PATCH_STATUS.ERROR, reason: `${blockers.length} 处无法判断（${names}）`, blockers };
	}
	const pending = records.filter((r) => PROCESSABLE.has(r?.state));
	if (pending.length) {
		return { status: PATCH_STATUS.NEEDS_ACTION, reason: `${pending.length} 处需要处理`, blockers: [] };
	}
	if (records.some((r) => r?.state !== "patched")) {
		return { status: PATCH_STATUS.ERROR, reason: "存在未知状态值", blockers: records };
	}
	return { status: PATCH_STATUS.PASS, reason: "全部已打补丁", blockers: [] };
}
