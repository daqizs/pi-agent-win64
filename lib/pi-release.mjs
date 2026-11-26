/**
 * pi-release.mjs —— 定位当前生效的 pi 安装（install/releases/<最新版本>）。
 *
 * `pi update` 会整块替换 install/releases/<版本>/，所以脚本一律不能写死版本号：
 * 之前 _dev 下有一批脚本写死 1.3.0，版本一升整条校验链就全断（module not found）。
 * 这里统一解析「版本号最高且包完整」的那一版。
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PKG = ["@earendil-works", "pi-coding-agent"];

export function releasesDir() {
  const root = process.env.PI_MANAGED_INSTALL_ROOT || join(homedir(), ".pi", "agent", "install");
  return join(root, "releases");
}

function compareVersion(a, b) {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < 3; i++) {
    const diff = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 最新一版里 @earendil-works/pi-coding-agent 的包目录；没有可用安装时返回 undefined */
export function findPiPackageDir() {
  const dir = releasesDir();
  if (!existsSync(dir)) return undefined;
  const latest = readdirSync(dir)
    .filter((d) => /^\d+\.\d+\.\d+/.test(d))
    .filter((d) => existsSync(join(dir, d, "node_modules", ...PKG, "package.json")))
    .sort(compareVersion)
    .at(-1);
  return latest ? join(dir, latest, "node_modules", ...PKG) : undefined;
}

/** 最新一版的 node_modules —— _dev 脚本 import pi-tui 等依赖时用 */
export function findNodeModulesDir() {
  const pkgDir = findPiPackageDir();
  return pkgDir ? join(pkgDir, "..", "..") : undefined;
}

/** 同 findNodeModulesDir，但找不到就直接抛错（给必须能跑起来的脚本用） */
export function requireNodeModulesDir() {
  const dir = findNodeModulesDir();
  if (!dir) throw new Error(`找不到 pi 安装目录：${releasesDir()}`);
  return dir;
}
