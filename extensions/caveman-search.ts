import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

// caveman 的存档库：~/.caveman/ccr.db 的 typed_objects 表
// （caveman 自己不提供检索入口，只认 recovery_handle —— 这里补上「按关键词找」这一半）
const cavemanHome = process.env.CAVEMAN_HOME ?? resolve(homedir(), ".caveman");
const dbPath = process.env.CAVEMAN_DB ?? resolve(cavemanHome, "ccr.db");

let cached: DatabaseSync | null | undefined;

// 懒打开 + 吞异常：库缺失时只让工具报错，绝不能拖垮 pi 启动
// node:sqlite 没有 fileMustExist 选项，缺文件时用 existsSync 提前判掉
function getDb(): DatabaseSync | null {
	if (cached !== undefined) return cached;
	try {
		if (!existsSync(dbPath)) throw new Error(`caveman db not found: ${dbPath}`);
		cached = new DatabaseSync(dbPath, { readOnly: true });
		cached.exec("PRAGMA busy_timeout = 2000");
	} catch {
		cached = null;
	}
	return cached;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const MAX_TERMS = 6;
// caveman 自己的决策遥测（占全库行数 ~85%）和工具确认快照，检索默认不进结果
const DEFAULT_EXCLUDE = ["TaskDecision", "DiffSnapshot"];
const SNIPPET_PAD = 140;
const SNIPPET_LEN = 340;

function fmtSize(n: unknown): string {
	const v = Number(n);
	if (!Number.isFinite(v) || v <= 0) return "?";
	if (v < 1024) return `${v}B`;
	if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`;
	return `${(v / 1024 / 1024).toFixed(1)}MB`;
}

function fmtTime(iso: unknown): string {
	return String(iso ?? "")
		.replace("T", " ")
		.replace(/\.\d+/, "")
		.replace(/Z$/, "");
}

const cleanSnippet = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

interface SessionRow {
	session_id: string;
	n: number;
	first_at: string;
	last_at: string;
	types: string | null;
}

interface HitRow {
	object_id: string;
	object_type: string;
	source: string;
	session_id: string;
	created_at: string;
	lifecycle: string;
	original_byte_length: number;
	snippet: string;
}

export default function cavemanSearch(pi: ExtensionAPI) {
	pi.registerTool({
		name: "caveman_search",
		label: "Caveman Search",
		description:
			"跨会话检索 caveman 存档（~/.caveman/ccr.db 的 typed_objects）：按关键词搜历史会话里存下的工具输出、文件内容、模型消息、事件记录。" +
			"多个词用空格分隔，需全部命中（AND），结果按时间倒序。默认不返回 caveman 自己的决策遥测（TaskDecision）和 DiffSnapshot；用 exclude 可改。" +
			"返回摘要 + object_id；要逐字节原文再调 caveman_retrieve({recovery_handle:\"<object_id>\"})。compact=true 时每条仅一行，用于快速定位、也更不容易被压缩成 stub。" +
			"不传 query 时列出最近会话概览（session_id / 对象数 / 时间范围），用来定位该翻哪个会话；sort=\"objects\" 改按对象数排。",
		promptSnippet: "Search content stored from all past sessions by keyword",
		promptGuidelines: [
			"用户问「以前 / 上次 / 之前那个会话里……」时，先用 caveman_search 查存档，不要凭记忆猜。",
			"caveman_search 只返回摘要；需要完整原文时，用返回的 object_id 调 caveman_retrieve。",
		],
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "关键词，空格分隔表示 AND；留空则列最近会话概览",
				},
				since: { type: "string", description: "起始时间（ISO 或 YYYY-MM-DD，可选）" },
				until: { type: "string", description: "结束时间（ISO 或 YYYY-MM-DD，可选）" },
				session: { type: "string", description: "按 session_id 子串过滤（可选）" },
				type: {
					type: "string",
					description: "按 object_type 精确过滤，如 FileObservation / CommandResult / native:model.after",
				},
				limit: { type: "number", description: "返回条数，默认 10，上限 50" },
				sort: { type: "string", description: "概览排序：recent（默认，按最近活动）/ objects（按对象数）" },
				compact: { type: "boolean", description: "true 时每条仅一行（时间/类型/大小/句柄，无摘要），输出更短、不易被 caveman 压成 stub" },
				exclude: {
					type: "string",
					description: `不想要的 object_type，逗号分隔；默认 "${DEFAULT_EXCLUDE.join(",")}"。传空字符串取消默认排除`,
				},
			},
		},
		async execute(_toolCallId, params) {
			const db = getDb();
			if (!db) {
				return {
					content: [
						{
							type: "text",
							text: `找不到 caveman 存档库：${dbPath}\n（可用环境变量 CAVEMAN_DB 指定路径；确认 caveman 曾在此机器上运行过）`,
						},
					],
					details: { error: "db_missing", dbPath },
				};
			}

			const rawLimit = Number(params.limit ?? 10);
			const limit = Math.min(50, Math.max(1, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 10));
			const q = String(params.query ?? "").trim();

			// ---- 通用元数据过滤 ----
			const filters: string[] = [];
			const filterArgs: unknown[] = [];
			if (params.since) {
				filters.push("created_at >= ?");
				filterArgs.push(String(params.since));
			}
			if (params.until) {
				filters.push("created_at <= ?");
				filterArgs.push(String(params.until));
			}
			if (params.session) {
				filters.push("session_id LIKE ? ESCAPE '\\'");
				filterArgs.push(`%${escapeLike(String(params.session))}%`);
			}
			if (params.type) {
				filters.push("object_type = ?");
				filterArgs.push(String(params.type));
			}
			// 默认排除 caveman 决策遥测/确认快照；显式传 type 时以调用方为准，不叠加默认排除
			const excludeRaw =
				params.exclude === undefined
					? params.type
						? ""
						: DEFAULT_EXCLUDE.join(",")
					: String(params.exclude);
			const excluded = excludeRaw
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			if (excluded.length) {
				filters.push(`object_type NOT IN (${excluded.map(() => "?").join(",")})`);
				filterArgs.push(...excluded);
			}
			const filterSql = filters.length ? ` AND ${filters.join(" AND ")}` : "";

			const overall = db
				.prepare("SELECT count(*) AS c, min(created_at) AS a, max(created_at) AS b FROM typed_objects")
				.get() as { c: number; a: string | null; b: string | null };

			// ---- 无关键词：会话概览 ----
			if (!q) {
				// 用 object_type 而不是 source 聚合：source 列可能是整条命令（自由文本），会把输出撑爆
				const sessions = db
					.prepare(
						`SELECT session_id, count(*) AS n, min(created_at) AS first_at, max(created_at) AS last_at,
						        group_concat(DISTINCT object_type) AS types
						 FROM typed_objects WHERE 1=1${filterSql}
						 GROUP BY session_id ORDER BY ${params.sort === "objects" ? "n DESC" : "last_at DESC"} LIMIT ?`,
					)
					.all(...filterArgs, limit) as SessionRow[];

				const lines = sessions.map((s) => {
					const types = String(s.types ?? "").split(",").filter(Boolean);
					const shown = types.slice(0, 8).join("/");
					const more = types.length > 8 ? ` +${types.length - 8}` : "";
					return (
						`- ${s.session_id} · ${s.n} 个对象 · ${fmtTime(s.first_at)} → ${fmtTime(s.last_at)}` +
						(shown ? ` · ${shown}${more}` : "")
					);
				});
				const text =
					`最近 ${sessions.length} 个会话（存档共 ${overall.c} 个对象，${fmtTime(overall.a)} → ${fmtTime(overall.b)}）：\n` +
					(lines.join("\n") || "（没有匹配的会话）") +
					`\n\n提示：拿 session_id 当 session 过滤条件复查，或直接给 query 关键词。`;

				return { content: [{ type: "text", text }], details: { sessions, total: overall.c } };
			}

			// ---- 关键词检索：所有词必须命中（AND）----
			const terms = q.split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
			const contentSql = terms.map(() => "CAST(data AS TEXT) LIKE ? ESCAPE '\\'");
			const contentArgs = terms.map((t) => `%${escapeLike(t)}%`);
			const where = ["length(CAST(data AS TEXT)) > 0", ...contentSql].join(" AND ") + filterSql;

			const total = (
				db.prepare(`SELECT count(*) AS c FROM typed_objects WHERE ${where}`).get(...contentArgs, ...filterArgs) as {
					c: number;
				}
			).c;

			const compact = params.compact === true;
			const snippetSql = compact
				? "'' AS snippet"
				: `substr(CAST(data AS TEXT), max(1, instr(lower(CAST(data AS TEXT)), lower(?)) - ${SNIPPET_PAD}), ${SNIPPET_LEN}) AS snippet`;
			const hits = db
				.prepare(
					`SELECT object_id, object_type, source, session_id, created_at, lifecycle, original_byte_length, ${snippetSql}
					 FROM typed_objects WHERE ${where}
					 ORDER BY created_at DESC LIMIT ?`,
				)
				.all(...(compact ? [] : [terms[0]]), ...contentArgs, ...filterArgs, limit) as HitRow[];

			const blocks = hits.map((h, i) =>
				compact
					? `${i + 1}) ${fmtTime(h.created_at)} · ${h.object_type} · ${fmtSize(h.original_byte_length)} · ${h.object_id}`
					: [
							`${i + 1}) ${fmtTime(h.created_at)} · ${h.object_type} · ${fmtSize(h.original_byte_length)} · ${h.lifecycle} · ${h.object_id}`,
							`   ${h.session_id}`,
							`   …${cleanSnippet(h.snippet)}${cleanSnippet(h.snippet).length >= SNIPPET_LEN ? "…" : ""}`,
						].join("\n"),
			);

			const text =
				`命中 ${total} 条（存档 ${overall.c} 个对象 / ${fmtTime(overall.a)} → ${fmtTime(overall.b)}），显示最近 ${hits.length} 条：\n\n` +
				(blocks.join(compact ? "\n" : "\n\n") || "（没有命中）") +
				(hits.length ? `\n\n取逐字节原文：caveman_retrieve({ recovery_handle: "<上面的 ccr_obj_... object_id>" })` : "");

			return {
				content: [{ type: "text", text }],
				details: { total, shown: hits.length, hits },
			};
		},
	});
}
