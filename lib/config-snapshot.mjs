#!/usr/bin/env node
/**
 * pi 配置快照 / 一键还原引擎（Windows 11「系统还原」思路）
 *
 * 职责边界：
 *   - 快照 = 「配置面」的可判定集合（settings/mcp/models/auth/lsp/tool-hud、AGENTS.md、
 *     extensions、skills、agents、workflows、missions、profiles、_dev、lib、docs、data，
 *     以及 ~/.pi-profile-switch 里 profile 的 profiles/** 和各实例的真身 settings/mcp）。
 *   - 不含：install/、npm/、sessions/、web-search-cache/、background/、bin/、
 *     node_modules —— 这些是运行时/二进制/历史，还原它们没有意义且会打碎安装。
 *   - 每个快照自带 sha256 清单；还原前校验，还原后复校验；还原本身先自动建还原点（可撤销）。
 *
 * 用法：
 *   node config-snapshot.mjs list
 *   node config-snapshot.mjs create [--label "改动前"] [--force]
 *   node config-snapshot.mjs diff [<id>] [--all]           # 对比当前配置（默认最新快照）
 *   node config-snapshot.mjs restore [<id>|--last] [--dry-run] [--keep-extra] [--force]
 *   node config-snapshot.mjs verify [<id>]
 *   node config-snapshot.mjs prune [--keep 15] [--dry-run]
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const SNAPSHOT_VERSION = 1;
const DEFAULT_KEEP = 15;

/** agent 目录下参与快照的子目录（白名单） */
const AGENT_DIRS = ["_dev", "extensions", "agents", "skills", "prompts", "workflows", "missions", "profiles", "pi-subagents", "data", "lib", "docs"];

/** 任意层级都跳过的目录名 */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv", ".cache", "dist", "build",
  "install", "npm", "sessions", "web-search-cache", "background", "bin", "snapshots", "trash",
]);

const CONFIG_EXT = /\.(json|jsonc|md|js|mjs|cjs|ts|py|sh|ps1|bat|cmd|toml|ya?ml|txt)$/i;
const SKIP_FILE = [/\.lock$/i, /\.log$/i, /\.tmp$/i, /\.bak/i, /~$/, /^\.DS_Store$/i, /-wal$/i, /-shm$/i, /^\./];

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const nowId = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-` +
  `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;

export function paths(env = process.env) {
  const agentDir = path.resolve(env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
  const psDir = path.resolve(env.PI_PROFILE_SWITCH_DIR || path.join(os.homedir(), ".pi-profile-switch"));
  return {
    agentDir,
    psDir,
    snapshotDir: path.resolve(env.PI_SNAPSHOT_DIR || path.join(agentDir, "snapshots")),
    trashDir: path.resolve(env.PI_TRASH_DIR || path.join(agentDir, "trash")),
  };
}

function skippedFile(name) {
  return SKIP_FILE.some((re) => re.test(name));
}

async function walk(rootDir, relBase, out) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(rootDir, e.name);
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    // 符号链接一律跳过：profile 实例是链接农场，跟随会重复计数
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(abs, rel, out);
    } else if (e.isFile() && !skippedFile(e.name)) {
      out.push({ rel, abs });
    }
  }
}

/** 枚举当前配置面（不跟随符号链接；返回 [{path, abs, sha256, size, mode}] 已排序） */
export async function scan(env = process.env) {
  const p = paths(env);
  const out = [];

  // 根 1：agent 目录。子目录走白名单，根级文件走扩展名白名单
  let agentEntries = [];
  try {
    agentEntries = await fs.readdir(p.agentDir, { withFileTypes: true });
  } catch {}
  for (const e of agentEntries) {
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || !AGENT_DIRS.includes(e.name)) continue;
      const found = [];
      await walk(path.join(p.agentDir, e.name), e.name, found);
      for (const f of found) out.push({ ...f, root: "agent" });
    } else if (e.isFile() && CONFIG_EXT.test(e.name) && !skippedFile(e.name)) {
      out.push({ rel: e.name, abs: path.join(p.agentDir, e.name), root: "agent" });
    }
  }

  // 根 2：~/.pi-profile-switch —— profile 定义 + 各实例的真身 settings/mcp
  const psFound = [];
  await walk(path.join(p.psDir, "profiles"), "profiles", psFound);
  const instDir = path.join(p.psDir, "instances");
  let insts = [];
  try {
    insts = await fs.readdir(instDir, { withFileTypes: true });
  } catch {}
  for (const inst of insts.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!inst.isDirectory()) continue;
    for (const name of ["settings.json", "mcp.json"]) {
      const abs = path.join(instDir, inst.name, name);
      try {
        // 链接（指向 agent 同名文件）跳过，避免同一份配置两个还原目标
        if ((await fs.lstat(abs)).isFile()) psFound.push({ rel: `instances/${inst.name}/${name}`, abs });
      } catch {}
    }
  }
  for (const f of psFound) out.push({ ...f, root: "ps" });

  const files = [];
  for (const f of out) {
    const buf = await fs.readFile(f.abs);
    const st = await fs.stat(f.abs);
    files.push({
      path: `${f.root}/${f.rel}`,
      abs: f.abs,
      sha256: sha256(buf),
      size: buf.length,
      mode: st.mode & 0o777,
      mtimeMs: Math.round(st.mtimeMs),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

const configHashOf = (files) =>
  sha256(files.map((f) => `${f.path}\0${f.sha256}\n`).join(""));

/**
 * createdAt 统一成 ISO 字符串：手写/旧版 manifest 里可能是数字毫秒或 Date 序列化结果，
 * 不归一化就会在排序时炸在 localeCompare 上。无法解析则报出文件与收到的类型。
 */
function normalizeCreatedAt(value, file) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  const got = value === null ? "null" : typeof value;
  throw new Error(`${file} 的 createdAt 无法解析（收到 ${got}: ${JSON.stringify(value) ?? String(value)}）`);
}

async function readManifest(dir) {
  const file = path.join(dir, "manifest.json");
  const raw = await fs.readFile(file, "utf8");
  const m = JSON.parse(raw);
  m.createdAt = normalizeCreatedAt(m.createdAt, file);
  return m;
}

/** 快照列表，新的在前 */
export async function listSnapshots(env = process.env) {
  const { snapshotDir } = paths(env);
  let dirs = [];
  try {
    dirs = await fs.readdir(snapshotDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const list = [];
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    try {
      const m = await readManifest(path.join(snapshotDir, d.name));
      list.push({
        id: m.id,
        createdAt: m.createdAt,
        label: m.label || "",
        files: m.files.length,
        bytes: m.files.reduce((s, f) => s + f.size, 0),
        configHash: m.configHash,
        kind: m.kind || "manual",
        dir: path.join(snapshotDir, d.name),
      });
    } catch (e) {
      // 没有 manifest.json = 未完成的快照目录，静默跳过；其它错误必须点名，别让快照静默消失
      if (e?.code !== "ENOENT") warnLine(`跳过 ${d.name}：${e?.message || e}`);
    }
  }
  list.sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)));
  return list;
}

function uniqueId(existing) {
  const base = nowId();
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** 建快照；与最新快照内容相同则跳过（除非 force） */
export async function createSnapshot({ label = "", kind = "manual", force = false, env = process.env } = {}) {
  const p = paths(env);
  const files = await scan(env);
  const configHash = configHashOf(files);

  const existing = await listSnapshots(env);
  const latest = existing[0];
  if (!force && latest && latest.configHash === configHash) {
    return { skipped: true, reason: "配置与最新快照相同", latest: latest.id };
  }

  const id = uniqueId(new Set(existing.map((s) => s.id)));
  const dir = path.join(p.snapshotDir, id);
  const tmpDir = path.join(p.snapshotDir, `.tmp-${id}`);
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(path.join(tmpDir, "tree"), { recursive: true });

  // 与上一快照内容相同的文件直接硬链过去：快照树只由本工具写，不会被就地改写
  let prevTree = null;
  let prevByPath = new Map();
  if (latest) {
    try {
      const prevManifest = await readManifest(latest.dir);
      prevTree = path.join(latest.dir, "tree");
      prevByPath = new Map(prevManifest.files.map((f) => [f.path, f]));
    } catch {}
  }

  const entries = [];
  for (const f of files) {
    const dest = path.join(tmpDir, "tree", f.path);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const prev = prevByPath.get(f.path);
    if (prevTree && prev && prev.sha256 === f.sha256) {
      try {
        await fs.link(path.join(prevTree, f.path), dest);
        entries.push({ path: f.path, sha256: prev.sha256, size: prev.size, mode: prev.mode });
        continue;
      } catch {
        // 硬链失败（跨卷等）就退回复制
      }
    }
    await fs.copyFile(f.abs, dest);
    // 以「复制后的字节」为准，保证快照内部自洽
    const buf = await fs.readFile(dest);
    entries.push({ path: f.path, sha256: sha256(buf), size: buf.length, mode: f.mode });
    await fs.chmod(dest, 0o644);
  }

  let delta = null;
  if (latest && prevByPath.size > 0) {
    let added = 0;
    let modified = 0;
    const curPaths = new Set();
    for (const e of entries) {
      curPaths.add(e.path);
      const prev = prevByPath.get(e.path);
      if (!prev) added++;
      else if (prev.sha256 !== e.sha256) modified++;
    }
    let removed = 0;
    for (const pKey of prevByPath.keys()) {
      if (!curPaths.has(pKey)) removed++;
    }
    delta = { baseId: latest.id, added, modified, removed };
  }

  const finalLabel =
    label || (delta && (delta.added || delta.modified || delta.removed) ? `+${delta.added} ~${delta.modified} -${delta.removed}` : "");

  const manifest = {
    version: SNAPSHOT_VERSION,
    id,
    kind,
    label: finalLabel,
    createdAt: new Date().toISOString(),
    agentDir: p.agentDir,
    psDir: p.psDir,
    configHash: configHashOf(entries.map((e) => ({ ...e, abs: null }))),
    counts: { files: entries.length, bytes: entries.reduce((s, e) => s + e.size, 0) },
    files: entries,
  };
  await fs.writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  // 先落 manifest 再原子改名：半成品目录不会出现在列表里
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rename(tmpDir, dir);

  const { removed: pruned } = await pruneSnapshots({ keep: DEFAULT_KEEP, env, protect: [id] });
  return { skipped: false, id, dir, counts: manifest.counts, configHash, pruned, delta };
}

/** 定向删除指定还原点（支持精确 ID 或前缀匹配） */
export async function deleteSnapshot(id, env = process.env) {
  if (!id) throw new Error("请指定要删除的还原点 ID");
  const snaps = await listSnapshots(env);
  const snap = snaps.find((s) => s.id === id) || snaps.find((s) => s.id.startsWith(id));
  if (!snap) throw new Error(`找不到快照 ${id}`);
  await fs.rm(snap.dir, { recursive: true, force: true });
  return { id: snap.id, label: snap.label };
}

async function hashOf(abs) {
  try {
    const buf = await fs.readFile(abs);
    return { sha256: sha256(buf), size: buf.length };
  } catch {
    return null;
  }
}

function absFor(relPath, p) {
  const [root, ...rest] = relPath.split("/");
  const base = root === "agent" ? p.agentDir : p.psDir;
  return path.join(base, ...rest);
}

/** 计划：快照 vs 当前 */
export async function planRestore(id, env = process.env) {
  const p = paths(env);
  const snaps = await listSnapshots(env);
  const snap = id ? snaps.find((s) => s.id === id) || snaps.find((s) => s.id.startsWith(id)) : snaps[0];
  if (!snap) throw new Error(id ? `找不到快照 ${id}` : "没有任何快照，先执行 create");
  const manifest = await readManifest(snap.dir);
  const current = await scan(env);
  const cur = new Map(current.map((f) => [f.path, f]));
  const snapPaths = new Set(manifest.files.map((f) => f.path));

  const writes = [];
  for (const f of manifest.files) {
    const c = cur.get(f.path);
    if (!c) writes.push({ path: f.path, action: "add", sha256: f.sha256, size: f.size });
    else if (c.sha256 !== f.sha256) writes.push({ path: f.path, action: "modify", sha256: f.sha256, size: f.size, from: c.sha256, curSize: c.size });
  }
  const removals = current.filter((f) => !snapPaths.has(f.path)).map((f) => ({ path: f.path, action: "remove", sha256: f.sha256, size: f.size }));

  return { snapshot: snap, manifest, writes, removals, unchanged: manifest.files.length - writes.length, absFor: (rel) => absFor(rel, p) };
}

/** 校验快照文件未被篡改/损坏 */
export async function verifySnapshot(id, env = process.env) {
  const snaps = await listSnapshots(env);
  const snap = id ? snaps.find((s) => s.id === id) || snaps.find((s) => s.id.startsWith(id)) : snaps[0];
  if (!snap) throw new Error(id ? `找不到快照 ${id}` : "没有任何快照");
  const manifest = await readManifest(snap.dir);
  const bad = [];
  for (const f of manifest.files) {
    const h = await hashOf(path.join(snap.dir, "tree", f.path));
    if (!h || h.sha256 !== f.sha256) bad.push(f.path);
  }
  return { ok: bad.length === 0, id: snap.id, files: manifest.files.length, bad };
}

/**
 * 还原。默认行为（一键）：
 *   1. 校验快照完整  2. 先建「还原前」还原点（撤销用）  3. 原子写回  4. 后复校验
 *   5. 快照里没有、当前多出来的配置 → 移入 trash/（不硬删），加 --keep-extra 则原样保留
 */
export async function restoreSnapshot(id, { dryRun = false, keepExtra = false, force = false, env = process.env } = {}) {
  const plan = await planRestore(id, env);
  const { snapshot, writes, removals, unchanged } = plan;

  const summary = {
    id: snapshot.id,
    label: snapshot.label,
    dryRun,
    added: writes.filter((w) => w.action === "add").map((w) => w.path),
    modified: writes.filter((w) => w.action === "modify").map((w) => w.path),
    removed: removals.map((r) => r.path),
    unchanged,
  };

  if (dryRun) return summary;

  const v = await verifySnapshot(snapshot.id, env);
  if (!v.ok && !force) {
    throw new Error(`快照 ${snapshot.id} 有 ${v.bad.length} 个文件校验失败（可能已损坏），未做任何改动：\n  ${v.bad.slice(0, 10).join("\n  ")}`);
  }

  // 还原点自身也要可撤销：先给当前状态打点
  const pre = await createSnapshot({ label: `还原前自动备份（将被还原到 ${snapshot.id}）`, kind: "pre-restore", env, force: true });

  const p = paths(env);
  const written = [];
  const failed = [];
  for (const w of writes) {
    const dest = absFor(w.path, p);
    const src = path.join(snapshot.dir, "tree", w.path);
    const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.restore-${crypto.randomBytes(4).toString("hex")}`);
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, tmp);
      const entry = plan.manifest.files.find((f) => f.path === w.path);
      if (entry?.mode) await fs.chmod(tmp, entry.mode);
      await fs.rename(tmp, dest); // Windows: 覆盖已存在文件
      written.push(w.path);
    } catch (e) {
      failed.push({ path: w.path, error: e.message });
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  const trashed = [];
  const trashRoot = path.join(p.trashDir, `${nowId()}-restore-${snapshot.id}`);
  if (!keepExtra) {
    for (const r of removals) {
      const src = absFor(r.path, p);
      const dest = path.join(trashRoot, r.path);
      try {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rename(src, dest);
        trashed.push(r.path);
      } catch (e) {
        // 跨盘/占用时退化为复制后删除
        try {
          await fs.copyFile(src, dest);
          await fs.unlink(src);
          trashed.push(r.path);
        } catch (e2) {
          failed.push({ path: r.path, error: `移除失败：${e2.message}` });
        }
      }
    }
  }

  // 后复校验：写回的文件必须与快照一致
  const bad = [];
  for (const rel of written) {
    const entry = plan.manifest.files.find((f) => f.path === rel);
    const h = await hashOf(absFor(rel, p));
    if (!h || h.sha256 !== entry.sha256) bad.push(rel);
  }

  return {
    ...summary,
    dryRun: false,
    written,
    trashed,
    keptExtra: keepExtra ? removals.map((r) => r.path) : [],
    trashRoot: keepExtra ? null : trashRoot,
    preSnapshotId: pre.skipped ? null : pre.id,
    failed,
    verified: bad.length === 0,
    verifyFailed: bad,
  };
}

/**
 * 保留最近 keep 个（pre-restore 也计入，保证一定能撤销最近一次还原）
 * dryRun：只算出会删哪些，不落地
 */
export async function pruneSnapshots({ keep = DEFAULT_KEEP, env = process.env, protect = [], dryRun = false } = {}) {
  const list = await listSnapshots(env);
  const keepSet = new Set([...protect, ...list.slice(0, keep).map((s) => s.id)]);
  const removed = [];
  for (const s of list) {
    if (keepSet.has(s.id)) continue;
    if (!dryRun) await fs.rm(s.dir, { recursive: true, force: true });
    removed.push(s.id);
  }
  if (dryRun) return { removed, kept: list.length - removed.length };
  // 清理中断的临时目录
  const { snapshotDir } = paths(env);
  for (const name of await fs.readdir(snapshotDir).catch(() => [])) {
    if (name.startsWith(".tmp-")) await fs.rm(path.join(snapshotDir, name), { recursive: true, force: true });
  }
  return { removed, kept: list.length - removed.length };
}

export function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

/** 终端输出：固定 6 列前缀，内容同列对齐；超宽内容首尾保留中间省略，不破坏排版 */
const TAG = { info: "[INFO]", warn: "[WARN]", done: "[DONE]", fail: "[FAIL]" };
const MIN_KEEP = 2;
/** 长清单默认只展前 N 条，--all 展全；避免一次刷出几百行把结论冲掉 */
const MAX_LINES = 10;

function termWidth() {
  return Math.min(process.stdout.columns || 80, 100);
}

function fit(text, width = termWidth() - TAG.info.length - 1) {
  const s = String(text);
  if (s.length <= width) return s;
  const head = Math.ceil((width - 3) * 0.6);
  const tail = width - 3 - head;
  return `${s.slice(0, head)}...${s.slice(-tail)}`;
}

function say(tag, text) {
  console.log(`${tag} ${fit(text)}`);
}

function warnLine(text) {
  console.warn(`${TAG.warn} ${fit(text)}`);
}

/** 打印带分支符的清单，超过 MAX_LINES 时折叠尾巴 */
function treeLines(lines, { all = false } = {}) {
  const shown = all || lines.length <= MAX_LINES ? lines : lines.slice(0, MAX_LINES);
  for (const [i, l] of shown.entries()) {
    const last = i === shown.length - 1 && shown.length === lines.length;
    console.log(`  ${last ? "└─" : "├─"} ${l}`);
  }
  if (shown.length < lines.length) {
    say(TAG.info, `…另有 ${lines.length - shown.length} 个未显示（加 --all 展开）`);
  }
}

/** 家目录缩短为 ~，避免每行都被长路径撑爆 */
function tilde(p, env = process.env) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function describeSnapshot(s, index) {
  const when = new Date(s.createdAt);
  const stamp = `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  const tag = s.kind === "pre-restore" ? "撤销点" : s.kind === "auto" ? "自动" : "手动";
  return `${String(index + 1).padStart(2, "0")}. ${s.id}  ${stamp}  ${formatBytes(s.bytes)}  [${tag}] ${s.label}`.trim();
}

/* ------------------------------- CLI ------------------------------- */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--label") args.label = argv[++i];
    else if (a === "--keep") args.keep = Number(argv[++i]);
    else if (a === "--last") args.last = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--keep-extra") args.keepExtra = true;
    else if (a === "--force") args.force = true;
    else if (a === "--all") args.all = true;
    else if (a.startsWith("--")) throw new Error(`未知参数：${a}`);
    else args._.push(a);
  }
  return args;
}

/** 破坏性命令先声明作用目录，避免沙箱测试与生产目录互相误伤 */
function snapshotRootLine(env = process.env) {
  const { snapshotDir } = paths(env);
  const sandbox = Boolean(env.PI_SNAPSHOT_DIR || env.PI_AGENT_DIR);
  return `快照根目录 ${tilde(snapshotDir, env)} (${sandbox ? "SANDBOX" : "PRODUCTION"})`;
}

async function main(argv) {
  const [cmd = "help", ...rest] = argv;
  const args = parseArgs(rest);
  const env = process.env;

  switch (cmd) {
    case "create": {
      const r = await createSnapshot({ label: args.label || "", force: args.force, env });
      if (r.skipped) say(TAG.info, `没有改动，跳过建点（最新：${r.latest}）`);
      else say(TAG.done, `已建还原点 ${r.id}：${r.counts.files} 个文件，${formatBytes(r.counts.bytes)}${r.pruned.length ? `（自动清理旧点 ${r.pruned.length} 个）` : ""}`);
      return 0;
    }
    case "list": {
      const list = await listSnapshots(env);
      if (!list.length) return console.log(`${TAG.info} 还没有还原点，先执行：node config-snapshot.mjs create`), 0;
      for (const [i, s] of list.entries()) console.log(describeSnapshot(s, i));
      return 0;
    }
    case "diff": {
      const plan = await planRestore(args._[0], env);
      const changes = [...plan.writes, ...plan.removals];
      if (!changes.length) {
        say(TAG.done, `${plan.snapshot.id} 与当前配置完全一致`);
        return 0;
      }
      const by = (a) => changes.filter((w) => w.action === a).length;
      say(TAG.info, `对比 ${plan.snapshot.id} → 当前配置（${changes.length} 个文件变更：修改 ${by("modify")} / 新增 ${by("add")} / 当前多出 ${by("remove")}）`);
      const lines = [
        ...plan.writes.map((w) => ({ tag: w.action === "add" ? "[新增]" : "[修改]", path: w.path, size: w.size, curSize: w.curSize })),
        ...plan.removals.map((r) => ({ tag: "[多出]", path: r.path, size: r.size })),
      ];
      treeLines(
        lines.map((l) => {
          const delta = l.curSize === undefined ? formatBytes(l.size) : `${formatBytes(l.size)} → ${formatBytes(l.curSize)}`;
          return `${fit(l.path, termWidth() - 30)}  ${delta}  ${l.tag}`;
        }),
        { all: args.all },
      );
      return 0;
    }
    case "verify": {
      const v = await verifySnapshot(args._[0], env);
      if (v.ok) say(TAG.done, `${v.id} 校验通过（${v.files} 个文件）`);
      else {
        say(TAG.fail, `${v.id} 校验失败：${v.bad.length} 个文件损坏`);
        for (const f of v.bad) console.log(`  └─ ${f}`);
      }
      return v.ok ? 0 : 1;
    }
    case "prune": {
      const keep = args.keep || DEFAULT_KEEP;
      say(TAG.info, snapshotRootLine(env));
      const { removed, kept } = await pruneSnapshots({ keep, env, dryRun: args.dryRun });
      if (!removed.length) say(TAG.info, `无需清理（剩余 ${kept} 个，保留上限 ${keep}）`);
      else {
        if (keep < MIN_KEEP) warnLine(`保留阈值过低（keep: ${keep}），建议 ≥ ${MIN_KEEP}；只剩 1 个点就没有回退到上一状态的机会`);
        if (args.dryRun) {
          say(TAG.info, `预演：将删除 ${removed.length} 个旧还原点（保留 ${kept} 个），未执行：`);
          treeLines(removed, { all: args.all });
        } else say(TAG.done, `已删除 ${removed.length} 个旧还原点（保留 ${kept} 个）：${removed.join(", ")}`);
      }
      return 0;
    }
    case "restore": {
      const id = args.last ? undefined : args._[0];
      say(TAG.info, snapshotRootLine(env));
      const r = await restoreSnapshot(id, { dryRun: args.dryRun, keepExtra: args.keepExtra, force: args.force, env });
      const head = `目标 ${r.id}${r.label ? `（${r.label}）` : ""}`;
      if (r.dryRun) {
        say(TAG.info, `${head} 预演：新增 ${r.added.length}，修改 ${r.modified.length}，移除 ${r.removed.length}，未变 ${r.unchanged}`);
        const lines = [
          ...r.added.map((p) => ({ tag: "[新增]", path: p })),
          ...r.modified.map((p) => ({ tag: "[修改]", path: p })),
          ...r.removed.map((p) => ({ tag: "[多出]", path: p })),
        ];
        treeLines(
          lines.map((l) => `${l.tag} ${fit(l.path, termWidth() - 12)}`),
          { all: args.all },
        );
        return 0;
      }
      say(TAG.done, `${head} 已还原：写回 ${r.written.length} 个文件，移出 ${r.trashed.length} 个；未变 ${r.unchanged}`);
      if (r.preSnapshotId) say(TAG.info, `还原前自动备份：${r.preSnapshotId}（撤销：restore ${r.preSnapshotId}）`);
      if (r.trashed.length && r.trashRoot) say(TAG.info, `移出的多余文件在：${tilde(r.trashRoot, env)}`);
      if (r.failed.length) {
        say(TAG.fail, `${r.failed.length} 项写回失败：`);
        for (const f of r.failed) console.log(`  └─ ${f.path}: ${f.error}`);
      }
      if (r.verified) say(TAG.done, "回读校验通过（字节与快照一致）");
      else say(TAG.fail, `回读校验失败：${r.verifyFailed.join(", ")}`);
      console.log(`${TAG.info} 配置已落盘，pi 里执行 /reload（或重启）后生效。`);
      return r.verified && !r.failed.length ? 0 : 1;
    }
    default:
      console.log(`用法：
  node config-snapshot.mjs list
  node config-snapshot.mjs create [--label "改动前"] [--force]
  node config-snapshot.mjs diff [<id>] [--all]
  node config-snapshot.mjs restore [<id>|--last] [--dry-run] [--keep-extra] [--force] [--all]
  node config-snapshot.mjs verify [<id>]
  node config-snapshot.mjs prune [--keep 15] [--dry-run] [--all]`);
      return cmd === "help" ? 0 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`${TAG.fail} ${e.message}`);
      process.exit(2);
    });
}
