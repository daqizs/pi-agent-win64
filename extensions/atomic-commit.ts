/**
 * atomic-commit.ts —— 原子化智能提交拆分（/commit）
 *
 * 借鉴 oh-my-pi 的 `omp commit`：
 *   - 扫描当前 git 工作区改动，自动跳过锁文件与 .bak/.tmp/.log 备份文件；
 *   - 按「源代码 > 测试 > 文档 > 配置」权重与目录作用域拆分原子提交组；
 *   - 先弹窗确认计划，再引导模型按组精确 `git add <files>` 并生成规范的 Conventional Commits。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { planAtomicCommits } from "../lib/atomic-commit-logic.mjs";

export default function atomicCommit(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "原子化拆分提交（自动过滤锁文件与备份）：/commit [dry]",
		handler: async (arg, ctx) => {
			const dryOnly = String(arg ?? "").trim().toLowerCase() === "dry";

			const repoCheck = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
			if (repoCheck.code !== 0) {
				ctx.ui.notify("atomic-commit: 当前目录不是 Git 仓库", "warning");
				return;
			}

			const statusRes = await pi.exec("git", ["status", "--porcelain"]);
			if (statusRes.code !== 0) {
				ctx.ui.notify(`atomic-commit: git status 失败：${statusRes.stderr || "未知错误"}`, "error");
				return;
			}

			const plan = planAtomicCommits(statusRes.stdout);
			if (!plan.groups.length) {
				const extra = plan.skipped.length ? `（已跳过 ${plan.skipped.length} 个锁文件/备份文件）` : "";
				ctx.ui.notify(`atomic-commit: 没有可提交的代码改动${extra}`, "info");
				return;
			}

			const lines = plan.groups.map(
				(g, i) => `  ${i + 1}. [${g.type}(${g.scope})] ${g.files.length} 个文件：${g.files.slice(0, 4).join(", ")}${g.files.length > 4 ? " …" : ""}`,
			);
			const skipNote = plan.skipped.length
				? `\n已自动忽略（${plan.skipped.length}）：${plan.skipped.map((s) => s.file).slice(0, 5).join(", ")}${plan.skipped.length > 5 ? " …" : ""}`
				: "";
			const preview = `建议拆分为 ${plan.groups.length} 个原子提交（源码优先）：\n${lines.join("\n")}${skipNote}`;

			if (dryOnly || !ctx.hasUI) {
				ctx.ui.notify(preview, "info");
				return;
			}

			ctx.ui.notify(preview, "info");
			const choice = await ctx.ui.select(`确认按 ${plan.groups.length} 组执行原子提交？`, [
				"执行：让 Pi 按分组顺序生成提交信息并分批提交",
				"仅预览：不执行 git commit",
			]);
			if (!choice || !choice.startsWith("执行")) return;

			const groupSpec = plan.groups
				.map((g, i) => `${i + 1}. 类型 \`${g.type}(${g.scope})\` — 文件：${g.files.map((f) => `\`${f}\``).join(", ")}`)
				.join("\n");

			const prompt = [
				"请按以下原子提交计划，逐组检查对应文件的 `git diff`，并用 Conventional Commits 风格（中文或英文简洁说明）分批执行 `git add <仅本组文件>` 和 `git commit`：",
				groupSpec,
				plan.skipped.length
					? `注意：不要暂存或提交以下自动忽略的锁文件/备份文件：${plan.skipped.map((s) => s.file).join(", ")}`
					: "",
				"每组提交后简报 commit hash 和标题，最后用 `git status --short` 确认状态。",
			]
				.filter(Boolean)
				.join("\n\n");

			pi.sendUserMessage(prompt);
		},
	});
}
