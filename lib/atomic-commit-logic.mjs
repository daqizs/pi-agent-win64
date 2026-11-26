/**
 * atomic-commit-logic.mjs —— 原子化 Git 提交拆分纯逻辑
 *
 * 借鉴 oh-my-pi 的 `omp commit` 思路：
 *   1. 自动识别并剔除锁文件（lockfile）与临时/备份文件，不污染提交分析；
 *   2. 按目录作用域 + 变更性质分组（源代码权重高于测试、文档与配置）；
 *   3. 输出有序的原子提交计划，供 `/commit` 预览并分批执行。
 */

const LOCKFILE_RE =
	/(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/i;

const TEMP_OR_BACKUP_RE = /(?:\.bak(?:-[\w.-]+)?|\.tmp|\.log|~)$/i;

const TEST_RE = /(?:^|\/)(?:__tests__|_dev|tests?|spec)\/|\.(?:test|spec)\.[a-z]+$/i;
const DOC_RE = /(?:^|\/)(?:docs?\/|README|CHANGELOG|LICENSE)|\.md$/i;
const CONFIG_RE =
	/(?:^|\/)(?:\.[^/]+rc(?:\.[a-z]+)?|tsconfig[^/]*\.json|package\.json|settings\.json|.*\.config\.[a-z]+|\.gitignore)$/i;

export function parsePorcelain(stdout) {
	const entries = [];
	for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
		if (!rawLine || rawLine.length < 4) continue;
		const status = rawLine.slice(0, 2);
		let file = rawLine.slice(3).trim();
		// rename 格式: "old -> new"
		const arrow = file.indexOf(" -> ");
		if (arrow !== -1) file = file.slice(arrow + 4).trim();
		file = file.replace(/^"|"$/g, "").replace(/\\/g, "/");
		if (!file) continue;
		entries.push({ status, file });
	}
	return entries;
}

export function classifyFile(file) {
	if (LOCKFILE_RE.test(file)) return { kind: "lockfile", priority: 99, scope: "lockfile" };
	if (TEMP_OR_BACKUP_RE.test(file)) return { kind: "backup", priority: 99, scope: "backup" };
	if (TEST_RE.test(file)) return { kind: "test", priority: 2, scope: scopeOf(file) };
	if (DOC_RE.test(file)) return { kind: "docs", priority: 3, scope: scopeOf(file) };
	if (CONFIG_RE.test(file)) return { kind: "chore", priority: 4, scope: scopeOf(file) };
	return { kind: "feat", priority: 1, scope: scopeOf(file) };
}

function scopeOf(file) {
	const parts = file.split("/").filter(Boolean);
	if (parts.length <= 1) return "root";
	if ((parts[0] === "src" || parts[0] === "packages" || parts[0] === "lib") && parts.length >= 3) {
		return parts[1];
	}
	return parts[0];
}

/**
 * 把 git status --porcelain 输出规划成有序的原子提交分组。
 * 源码优先（priority 1），其次测试（2）、文档（3）、配置（4）。
 */
export function planAtomicCommits(porcelainStdout) {
	const entries = parsePorcelain(porcelainStdout);
	const skipped = [];
	const buckets = new Map();

	for (const entry of entries) {
		const info = classifyFile(entry.file);
		if (info.kind === "lockfile" || info.kind === "backup") {
			skipped.push({ file: entry.file, reason: info.kind });
			continue;
		}
		const key = `${info.kind}:${info.scope}`;
		if (!buckets.has(key)) {
			buckets.set(key, {
				type: info.kind,
				scope: info.scope,
				priority: info.priority,
				files: [],
			});
		}
		buckets.get(key).files.push(entry.file);
	}

	const groups = [...buckets.values()].sort((a, b) => {
		if (a.priority !== b.priority) return a.priority - b.priority;
		return a.scope.localeCompare(b.scope);
	});

	return { groups, skipped, totalChanged: entries.length };
}
