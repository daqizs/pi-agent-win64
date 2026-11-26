/**
 * context-rewind.ts —— 探索分支检查点与上下文回卷（/checkpoint 与 /rewind）
 *
 * 借鉴 oh-my-pi 的 checkpoint / rewind 思路：
 *   - `/checkpoint [名称]`：在开始一段高噪音排障或探索前打下检查点；
 *   - `/rewind [名称|编号]`：探索结束后，调用 Pi 原生 `ctx.compact()` 把检查点之后的试错过程
 *     折叠成 1 段简洁结论（保留已验证事实、已排除的死路与下一步计划），保持上下文清爽。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface CheckpointMark {
	id: number;
	label: string;
	entryId: string;
	entryCount: number;
	createdAt: number;
}

function fmtAgo(ts: number): string {
	const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (sec < 60) return `${sec}s 前`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m 前`;
	return `${Math.floor(sec / 3600)}h 前`;
}

export default function contextRewind(pi: ExtensionAPI) {
	let marks: CheckpointMark[] = [];
	let seq = 0;

	pi.on("session_start", () => {
		marks = [];
		seq = 0;
	});

	pi.registerCommand("checkpoint", {
		description: "标记探索检查点：/checkpoint [名称] | list | clear",
		handler: async (arg, ctx) => {
			const raw = String(arg ?? "").trim();
			const lower = raw.toLowerCase();

			if (lower === "clear") {
				marks = [];
				seq = 0;
				if (ctx.hasUI) ctx.ui.setStatus("ctx-checkpoint", undefined);
				ctx.ui.notify("checkpoint: 已清空本会话所有检查点", "info");
				return;
			}

			if (lower === "list") {
				if (!marks.length) {
					ctx.ui.notify("checkpoint: 当前没有检查点，可用 `/checkpoint 排障开始` 新建", "info");
					return;
				}
				const text = marks
					.map((m) => `  #${m.id}  ${m.label}（${fmtAgo(m.createdAt)} · 当时 ${m.entryCount} 条记录）`)
					.join("\n");
				ctx.ui.notify(`当前检查点（${marks.length} 个）：\n${text}\n使用 /rewind 可折叠回卷`, "info");
				return;
			}

			const leafId = ctx.sessionManager.getLeafId() || `leaf-${Date.now()}`;
			const entries = ctx.sessionManager.getEntries?.() ?? [];
			const id = ++seq;
			const label = raw || `检查点-${id}`;
			marks.push({
				id,
				label,
				entryId: leafId,
				entryCount: entries.length,
				createdAt: Date.now(),
			});
			if (ctx.hasUI) ctx.ui.setStatus("ctx-checkpoint", `📍 #${id} ${label}`);
			ctx.ui.notify(`已标记检查点 #${id}「${label}」；探索结束后执行 /rewind 即可折叠试错上下文`, "info");
		},
	});

	pi.registerCommand("rewind", {
		description: "将指定检查点之后的探索轨迹折叠成简洁结论：/rewind [名称|编号]",
		handler: async (arg, ctx) => {
			if (!marks.length) {
				ctx.ui.notify("rewind: 还没有检查点，先用 `/checkpoint <名称>` 标记起点", "warning");
				return;
			}

			const query = String(arg ?? "").trim();
			let target: CheckpointMark | undefined;

			if (query) {
				const num = Number(query.replace(/^#/, ""));
				target = Number.isFinite(num)
					? marks.find((m) => m.id === num)
					: [...marks].reverse().find((m) => m.label.toLowerCase().includes(query.toLowerCase()));
				if (!target) {
					ctx.ui.notify(`rewind: 未找到匹配「${query}」的检查点（可用 /checkpoint list 查看）`, "warning");
					return;
				}
			} else if (marks.length === 1 || !ctx.hasUI) {
				target = marks[marks.length - 1];
			} else {
				const reversed = [...marks].reverse();
				const options = reversed.map((m) => `#${m.id} ${m.label}（${fmtAgo(m.createdAt)}）`);
				const picked = await ctx.ui.select("选择要回卷折叠的检查点：", options);
				if (!picked) return;
				target = reversed[options.indexOf(picked)];
			}

			if (!target) return;

			const currentCount = (ctx.sessionManager.getEntries?.() ?? []).length;
			const delta = Math.max(0, currentCount - target.entryCount);

			const instructions = [
				`用户在检查点 #${target.id}「${target.label}」之后进行了约 ${delta} 条探索/排障步骤，现在要求回卷并折叠这段探索轨迹。`,
				"请将检查点之后的试错过程高度压缩为 3 个简短小节：",
				"1. 【已验证事实与根因】（只留确凿结论与关键文件:行号）；",
				"2. 【已排除方向】（一句话列出试过但不通的路，避免重复踩坑）；",
				"3. 【当前状态与下一步】。",
				"丢弃中间冗长的报错堆栈、重复读取和无效输出，保留检查点之前确立的核心目标与约束。",
			].join("\n");

			try {
				ctx.compact({ customInstructions: instructions });
				ctx.ui.notify(`⏪ 正在按检查点 #${target.id}「${target.label}」折叠压缩后续探索上下文…`, "info");
				if (ctx.hasUI) ctx.ui.setStatus("ctx-checkpoint", undefined);
			} catch (e: any) {
				ctx.ui.notify(`rewind: 触发上下文压缩失败：${e?.message ?? String(e)}`, "error");
			}
		},
	});
}
