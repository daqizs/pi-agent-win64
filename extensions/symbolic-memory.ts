/**
 * symbolic-memory.ts —— 基于本地 SQLite 的持久化象征性记忆图谱
 *
 * 优化要点：
 *   1. 修复原 `pi.registerContextProvider` 在 Pi v1.6.1 不存在导致记忆从未注入的问题，
 *      改用 `before_agent_start` 动态召回「最新 user 核心事实 + 当前问题关键词匹配事实」并限额注入；
 *   2. 补齐 `memory_search`（关键词检索）、`memory_delete_fact`（按 rowid 或精确字段删除）
 *      以及 `memory_save_fact` 的 `replace: true` 覆盖更新语义；
 *   3. `memory_query_graph` 增加深度上限（5）、节点上限（40）与可选双向遍历；
 *   4. 新增 `/memory [search <词>|delete <id>|on|off]` 管理命令，并在 `session_shutdown` 做 WAL checkpoint 与关闭。
 *
 * 100% 兼容原有 facts 表结构，零改动保留历史数据。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DatabaseSync } from "node:sqlite";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

interface FactRow {
	rowid: number;
	subject: string;
	predicate: string;
	object: string;
}

const MAX_INJECT_RECENT = 12;
const MAX_INJECT_MATCHED = 8;
const MAX_INJECT_CHARS = 2800;
const MAX_OBJ_PREVIEW = 240;

function openMemoryDb(): DatabaseSync {
	const dataDir = resolve(homedir(), ".pi", "agent", "data");
	const dbPath = process.env.MEMORY_DB_PATH?.trim() || resolve(dataDir, "symbolic_memory.db");
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec(`
CREATE TABLE IF NOT EXISTS facts (
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  UNIQUE(subject, predicate, object)
);
CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject);
CREATE INDEX IF NOT EXISTS idx_facts_object ON facts(object);
`);
	return db;
}

const STOP_WORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "have", "what", "when", "where", "how",
	"帮我", "一下", "看看", "什么", "怎么", "可以", "需要", "现在", "一个", "这个", "那个", "一下吧",
]);

function extractKeywords(prompt: string): string[] {
	const cleaned = String(prompt ?? "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`\n]+`/g, " ");
	const raw = cleaned.match(/[A-Za-z0-9_.-]{3,}|[\u4e00-\u9fff]{2,6}/g) ?? [];
	const uniq: string[] = [];
	for (const tok of raw) {
		const lower = tok.toLowerCase();
		if (STOP_WORDS.has(lower) || uniq.includes(tok)) continue;
		uniq.push(tok);
		if (uniq.length >= 6) break;
	}
	return uniq;
}

function previewText(s: string, max = MAX_OBJ_PREVIEW): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function searchFacts(db: DatabaseSync, query: string, limit = 20): FactRow[] {
	const tokens = String(query ?? "")
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 6);
	if (!tokens.length) {
		return db
			.prepare(`SELECT rowid, subject, predicate, object FROM facts ORDER BY rowid DESC LIMIT ?`)
			.all(limit) as unknown as FactRow[];
	}
	const where = tokens.map(() => `(subject LIKE ? OR predicate LIKE ? OR object LIKE ?)`).join(" AND ");
	const params: any[] = [];
	for (const t of tokens) {
		const like = `%${t}%`;
		params.push(like, like, like);
	}
	params.push(limit);
	return db
		.prepare(`SELECT rowid, subject, predicate, object FROM facts WHERE ${where} ORDER BY rowid DESC LIMIT ?`)
		.all(...params) as unknown as FactRow[];
}

function buildContextBlock(db: DatabaseSync, userPrompt: string): string {
	const seen = new Set<number>();
	const picked: FactRow[] = [];

	// 1. 优先召回与当前问题关键词相关的事实
	const keywords = extractKeywords(userPrompt);
	if (keywords.length) {
		const stmt = db.prepare(
			`SELECT rowid, subject, predicate, object FROM facts WHERE subject LIKE ? OR predicate LIKE ? OR object LIKE ? ORDER BY rowid DESC LIMIT 4`,
		);
		for (const kw of keywords) {
			const like = `%${kw}%`;
			const rows = stmt.all(like, like, like) as unknown as FactRow[];
			for (const r of rows) {
				if (seen.has(r.rowid)) continue;
				seen.add(r.rowid);
				picked.push(r);
				if (picked.length >= MAX_INJECT_MATCHED) break;
			}
			if (picked.length >= MAX_INJECT_MATCHED) break;
		}
	}

	// 2. 补充最新的 user 核心事实（按 rowid DESC 倒序，确保最新规则在最前）
	const recent = db
		.prepare(`SELECT rowid, subject, predicate, object FROM facts WHERE subject = 'user' ORDER BY rowid DESC LIMIT ?`)
		.all(MAX_INJECT_RECENT) as unknown as FactRow[];
	for (const r of recent) {
		if (seen.has(r.rowid)) continue;
		seen.add(r.rowid);
		picked.push(r);
	}

	if (!picked.length) return "";

	const lines: string[] = [];
	let totalChars = 0;
	for (const f of picked) {
		const line = `- [#${f.rowid}] (${f.subject}) -> [${f.predicate}] -> (${previewText(f.object)})`;
		if (totalChars + line.length > MAX_INJECT_CHARS && lines.length > 0) break;
		lines.push(line);
		totalChars += line.length + 1;
	}

	return `### 已知用户态势与环境事实（象征性记忆 · 完整内容可用 memory_search 查询）:\n${lines.join("\n")}`;
}

export default function symbolicMemory(pi: ExtensionAPI) {
	const db = openMemoryDb();
	let autoInject = process.env.PI_SYMBOLIC_MEMORY_INJECT !== "0";
	let closed = false;

	// 真正生效的上下文注入：before_agent_start 拼接到 systemPrompt
	pi.on("before_agent_start", (event: any) => {
		if (!autoInject || closed) return;
		try {
			const userPrompt = event?.messageType === "user" ? String(event?.prompt ?? "") : "";
			const block = buildContextBlock(db, userPrompt);
			if (!block) return;
			const base = String(event?.systemPrompt ?? "");
			return { systemPrompt: base ? `${base}\n\n${block}` : block };
		} catch {
			return;
		}
	});

	pi.on("session_shutdown", () => {
		if (closed) return;
		closed = true;
		try {
			db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch {
			// 忽略 checkpoint 失败
		}
		try {
			db.close();
		} catch {
			// 忽略关闭失败
		}
	});

	// Tool 1: 保存或更新结构化事实
	pi.registerTool({
		name: "memory_save_fact",
		label: "保存记忆事实",
		description:
			"Record or update a structured fact (subject, predicate, object) in symbolic memory. Set replace=true to overwrite existing values for the same (subject, predicate).",
		parameters: Type.Object({
			subject: Type.String({ description: "Entity subject, e.g. 'user' or 'project'" }),
			predicate: Type.String({ description: "Relation or attribute, e.g. 'uses_framework'" }),
			object: Type.String({ description: "Value or target entity, e.g. 'React'" }),
			replace: Type.Optional(
				Type.Boolean({
					description: "When true, remove existing rows with the same (subject, predicate) before saving so single-valued facts do not conflict",
				}),
			),
		}),
		async execute(_callId, params) {
			const subject = String(params.subject ?? "").trim();
			const predicate = String(params.predicate ?? "").trim();
			const object = String(params.object ?? "").trim();
			if (!subject || !predicate || !object) {
				return { isError: true, content: [{ type: "text" as const, text: "subject、predicate、object 均不能为空" }] };
			}

			let replacedCount = 0;
			if (params.replace === true) {
				const del = db.prepare(`DELETE FROM facts WHERE subject = ? AND predicate = ?`).run(subject, predicate);
				replacedCount = Number(del.changes ?? 0);
			}
			db.prepare(`INSERT OR IGNORE INTO facts (subject, predicate, object) VALUES (?, ?, ?)`).run(
				subject,
				predicate,
				object,
			);
			const row = db
				.prepare(`SELECT rowid FROM facts WHERE subject = ? AND predicate = ? AND object = ?`)
				.get(subject, predicate, object) as { rowid?: number } | undefined;
			const note = replacedCount ? ` (replaced ${replacedCount} old value(s))` : "";
			return {
				content: [
					{
						type: "text" as const,
						text: `Fact stored [#${row?.rowid ?? "?"}]: (${subject}) -[${predicate}]-> (${object})${note}`,
					},
				],
				details: { rowid: row?.rowid, replacedCount },
			};
		},
	});

	// Tool 2: 关键词模糊搜索记忆
	pi.registerTool({
		name: "memory_search",
		label: "搜索记忆事实",
		description:
			"Search symbolic memory facts by keywords across subject, predicate, and object (newest first). Space-separated keywords are AND-matched.",
		parameters: Type.Object({
			query: Type.String({ description: "Keywords to search, e.g. 'WARP' or 'npm mirror' (empty returns latest)" }),
			limit: Type.Optional(Type.Number({ description: "Max rows to return (default 20, max 50)" })),
		}),
		async execute(_callId, params) {
			const limit = Math.max(1, Math.min(50, Number(params.limit ?? 20)));
			const rows = searchFacts(db, String(params.query ?? ""), limit);
			if (!rows.length) {
				return {
					content: [{ type: "text" as const, text: `No matching facts found for: ${params.query}` }],
					details: { count: 0, rows: [] },
				};
			}
			const lines = rows.map((r) => `[#${r.rowid}] (${r.subject}) -[${r.predicate}]-> (${r.object})`);
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { count: rows.length, rows },
			};
		},
	});

	// Tool 3: 删除过时/错误事实
	pi.registerTool({
		name: "memory_delete_fact",
		label: "删除记忆事实",
		description: "Delete outdated or incorrect facts from symbolic memory by exact rowid or by (subject, predicate[, object]).",
		parameters: Type.Object({
			rowid: Type.Optional(Type.Number({ description: "Exact rowid from memory_search / context block" })),
			subject: Type.Optional(Type.String({ description: "Exact subject (used with predicate when rowid is omitted)" })),
			predicate: Type.Optional(Type.String({ description: "Exact predicate (required when rowid is omitted)" })),
			object: Type.Optional(Type.String({ description: "Optional exact object to narrow deletion" })),
		}),
		async execute(_callId, params) {
			if (typeof params.rowid === "number" && Number.isFinite(params.rowid)) {
				const res = db.prepare(`DELETE FROM facts WHERE rowid = ?`).run(params.rowid);
				const n = Number(res.changes ?? 0);
				return {
					content: [{ type: "text" as const, text: n ? `Deleted fact #${params.rowid}` : `Fact #${params.rowid} not found` }],
					details: { deleted: n },
				};
			}
			const subject = String(params.subject ?? "").trim();
			const predicate = String(params.predicate ?? "").trim();
			const object = params.object !== undefined ? String(params.object).trim() : undefined;
			if (!subject || !predicate) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: "请提供 rowid，或同时提供精确的 subject 和 predicate" }],
				};
			}
			const res =
				object !== undefined
					? db.prepare(`DELETE FROM facts WHERE subject = ? AND predicate = ? AND object = ?`).run(subject, predicate, object)
					: db.prepare(`DELETE FROM facts WHERE subject = ? AND predicate = ?`).run(subject, predicate);
			const n = Number(res.changes ?? 0);
			return {
				content: [{ type: "text" as const, text: `Deleted ${n} fact(s) matching (${subject}) -[${predicate}]->` }],
				details: { deleted: n },
			};
		},
	});

	// Tool 4: 从指定实体出发遍历子图（带深度与节点安全上限）
	pi.registerTool({
		name: "memory_query_graph",
		label: "遍历记忆图谱",
		description: "Traverse facts from a starting entity up to a bounded depth (max 5, max 40 nodes) and return a JSON graph.",
		parameters: Type.Object({
			entity: Type.String({ description: "Starting subject to explore" }),
			depth: Type.Optional(Type.Number({ description: "Maximum hop count (1-5, default 2)" })),
			bidirectional: Type.Optional(Type.Boolean({ description: "Also include incoming edges pointing to the entity" })),
		}),
		async execute(_callId, params) {
			const startEntity = String(params.entity ?? "").trim();
			const maxDepth = Math.max(1, Math.min(5, Math.floor(Number(params.depth ?? 2))));
			const maxNodes = 40;
			const graph: Record<string, Array<{ predicate: string; object: string; direction?: "out" | "in" }>> = {};
			const visited = new Set<string>();

			const outStmt = db.prepare(`SELECT predicate, object FROM facts WHERE subject = ? ORDER BY rowid DESC LIMIT 30`);
			const inStmt = db.prepare(`SELECT subject, predicate FROM facts WHERE object = ? ORDER BY rowid DESC LIMIT 15`);

			function walk(node: string, remaining: number) {
				if (remaining < 0 || visited.has(node) || visited.size >= maxNodes) return;
				visited.add(node);

				const edges: Array<{ predicate: string; object: string; direction?: "out" | "in" }> = [];
				const outRows = outStmt.all(node) as unknown as Array<{ predicate: string; object: string }>;
				for (const r of outRows) {
					edges.push({ predicate: r.predicate, object: r.object });
				}
				if (params.bidirectional) {
					const inRows = inStmt.all(node) as unknown as Array<{ subject: string; predicate: string }>;
					for (const r of inRows) {
						edges.push({ predicate: r.predicate, object: r.subject, direction: "in" });
					}
				}
				if (edges.length) {
					graph[node] = edges;
					for (const e of edges) {
						if (visited.size >= maxNodes) break;
						walk(e.object, remaining - 1);
					}
				}
			}

			if (startEntity) walk(startEntity, maxDepth);

			return {
				content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
				details: { graph, nodes: visited.size },
			};
		},
	});

	// 斜杠命令：/memory [search <词> | delete <id> | on | off]
	pi.registerCommand("memory", {
		description: "查看/搜索/删除象征性记忆：/memory [search <词>|delete <id>|on|off]",
		handler: async (arg, ctx) => {
			const raw = String(arg ?? "").trim();
			const parts = raw.split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "").toLowerCase();

			if (sub === "on" || sub === "off") {
				autoInject = sub === "on";
				ctx.ui.notify(`symbolic-memory: 自动记忆注入已${autoInject ? "开启" : "关闭"}`, "info");
				return;
			}

			if (sub === "search") {
				const q = parts.slice(1).join(" ");
				const rows = searchFacts(db, q, 15);
				if (!rows.length) {
					ctx.ui.notify(`memory: 未找到包含「${q}」的记录`, "info");
					return;
				}
				const text = rows.map((r) => `#${r.rowid} (${r.subject}) -[${r.predicate}]-> ${previewText(r.object, 90)}`).join("\n");
				ctx.ui.notify(`搜索「${q}」命中 ${rows.length} 条：\n${text}`, "info");
				return;
			}

			if (sub === "delete" || sub === "del") {
				const id = Number(parts[1]);
				if (!Number.isFinite(id)) {
					ctx.ui.notify("用法：/memory delete <rowid>", "warning");
					return;
				}
				const row = db
					.prepare(`SELECT rowid, subject, predicate, object FROM facts WHERE rowid = ?`)
					.get(id) as FactRow | undefined;
				if (!row) {
					ctx.ui.notify(`memory: 未找到 #${id}`, "warning");
					return;
				}
				if (ctx.hasUI) {
					const ok = await ctx.ui.confirm(
						`删除记忆 #${id}？`,
						`(${row.subject}) -[${row.predicate}]-> ${previewText(row.object, 160)}`,
					);
					if (!ok) return;
				}
				db.prepare(`DELETE FROM facts WHERE rowid = ?`).run(id);
				ctx.ui.notify(`memory: 已删除 #${id}`, "info");
				return;
			}

			const total = (db.prepare(`SELECT COUNT(*) as c FROM facts`).get() as { c: number } | undefined)?.c ?? 0;
			const latest = searchFacts(db, "", 8);
			const lines = latest.map((r) => `  #${r.rowid} (${r.subject}) -[${r.predicate}]-> ${previewText(r.object, 80)}`);
			ctx.ui.notify(
				`symbolic-memory: 共 ${total} 条事实 · 自动注入：${autoInject ? "开" : "关"}\n最新 8 条：\n${lines.join("\n")}\n用法：/memory search <词> | /memory delete <id> | /memory on|off`,
				"info",
			);
		},
	});
}
