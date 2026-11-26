# Pi Agent Win64 增强套件（pi-agent-win64）

一套面向 Windows x64 的 [`@earendil-works/pi-coding-agent`](https://github.com/mariozechner/pi-coding-agent) 实战增强扩展包：在保留官方 Pi 轻量底座的基础上，补齐**单行精炼执行看板、收尾验收闸口、词控智能派单、按需纠偏安全员、AST 放样预览重构、后台子智能体控制台、按需红队审阅、原子化提交、上下文回卷、交互式系统还原快照与主动递小抄的持久化记忆**。

> **隐私安全说明**：本仓库与 Release 发行包已完整脱敏，不包含任何 API Key、`auth.json`、个人会话记录、个人记忆数据库或本机用户名路径。

---

## 用「装修施工队」看懂这套增强套件的 9 大优点

如果把默认 AI 编程助手比作一支刚组建的施工队，这套套件相当于给它配齐了**电动大门、电子看板、质检监理、智能派单、激光放样和老管家档案本**：

| 能力模块 | 解决的痛点 | 生活化类比（带来的好处） |
| :--- | :--- | :--- |
| **1. PowerShell 7 管理员启动器** (`win64/start-pi.bat`) | Windows 双击 `.bat` 默认进老旧 CMD，权限受限、中文编码容易乱 | 换成**带总钥匙的宽敞电动大门**：直接以管理员权限打开 Windows Terminal 的 PowerShell 7，UTF-8 编码一步到位 |
| **2. 单行精炼执行看板** (`tool-hud.ts`) | 每次调工具都把大段 JSON 和日志铺满屏幕，刷屏难看且重绘卡顿 | 换成**带便签缓存的高清电子看板**：成功调用压缩成清爽一行（附增删行数或中文一句话注解），出错立刻弹出原因+推断卡片；按对象引用缓存，重绘丝滑省内存 |
| **3. 统一标准质检监理** (`enforce-verify-gate.ts`) | 模型改完代码容易口头喊「已完成」却没实测，或者验收后再改却忘了重验 | 配备**认全 PowerShell/POSIX/AST 写入的质检监理**：只读查询绝不瞎催；只要真动了文件就必须交出带实测证据的 `hud_verify` 验收卡，没附证据一律标「仅声称」不给过 |
| **4. 词控智能派单** (`smart-router.ts`) | 平时用快模型省额度，遇难题想请强模型得手动切来切去 | 派单时顺嘴带个暗号：**`chillax`**（小事快答）、**`ultrathink`**（深度琢磨）、**`@opus` / `@pro` / `@flash`**（本单临时换师傅），干完这一单**自动切回原模型** |
| **5. 按需随身安全员 / 轻量 TTSR** (`ttsr-guard.ts`) | 把几十条规范全塞系统提示词既烧 token 又容易被快模型忘掉 | 规章平时**收在口袋里零 token 占用**；一旦模型刚伸手拿违规工具（`sed -i`、`echo >>` 改代码、缺 `-f` 的 `curl`、乱杀 Chrome、缺 BOM 的中文 `.ps1`），当场按住手并递上正确工具 |
| **6. 激光定位与放样预览** (`ast-tools.ts`) | 跨文件批量改代码用正则容易误伤注释与字符串 | 基于 `ast-grep` 按语法树精准定位（`ast_grep`）；重写（`ast_edit`）默认先打虚线放样预览（`dryRun: true`），确认不伤注释后再原子落盘 |
| **7. 监控大屏 + 外聘验房师** (`agent-hub.ts` / `advisor-review.ts`) | 后台子智能体跑起来看不清状态；改完大活心里没底又不想全程烧贵模型 | **`/hub`** 打开工地监控大屏，看状态/日志、一键叫停卡死进程；**`/advisor`** 仅在封墙前按次请强模型只读红队挑刺（P0–P2），验完立刻送走 |
| **8. 分箱归档 + 桌面整理术** (`atomic-commit.ts` / `context-rewind.ts`) | 完工提交把锁文件和备份全塞一团；长排障试错把对话桌堆满草稿 | **`/commit`** 自动筛掉 lockfile 和 `.bak`，按「源码 > 测试 > 文档 > 配置」分箱预览再提交；**`/checkpoint` + `/rewind`** 排障前插小旗、查完一键把试错草稿叠成 3 行便利贴 |
| **9. 相机存档 + 会递小抄的档案本** (`system-restore.ts` / `symbolic-memory.ts`) | 改崩配置不好回退；记了近百条环境忌讳却每次开工都想不起来看 | **`/snapshot` & `/snapshots`** 自动去重并附变更摘要，弹窗支持对比 diff / sha256 校验 / 保留新增文件还原；**`symbolic-memory`** 开工前自动按当前问题递上最相关+最新的核心规则小抄，随时 `/memory` 可搜可改可删 |

---

## Windows x64 下载与一键安装

### 方式一：直接下载 Release 压缩包（推荐）

1. 前往本仓库右侧 **[Releases](../../releases)** 页面，下载最新版 `pi-agent-win64-v1.0.0.zip`（附 `SHA256SUMS.txt` 校验文件）。
2. 解压到任意目录后，在 PowerShell 7 中执行一键安装：
   ```powershell
   .\win64\install-win64.ps1
   ```
3. 双击 `win64\start-pi.bat` 即可默认以管理员身份在 Windows Terminal（PowerShell 7）中启动 Pi。

### 方式二：前置依赖建议（Windows x64）

- **Node.js**（推荐 v22+ / v26+，支持原生 `node:sqlite`）
- **PowerShell 7**（`winget install Microsoft.PowerShell`）
- **ast-grep**（供 `ast_grep` / `ast_edit` 使用：`winget install ast-grep.ast-grep`）
- **Pi 本体**：按官方文档安装 `@earendil-works/pi-coding-agent`

---

## 常用斜杠命令速查

| 命令 | 说明 |
| :--- | :--- |
| `/hud [wb\|compact\|detail\|hidden\|off\|verify on\|off]` | 切换单行执行看板模式与验收提醒开关 |
| `/route [on\|off\|reload]` | 查看或开关 `ultrathink` / `chillax` / `@opus` / `@pro` 词控路由 |
| `/ttsr [on\|off\|reload]` | 查看按需纠偏规则命中统计或热重载 `ttsr-rules.json` |
| `/hub` | 打开轻量 Agent Hub，查看或终止后台子智能体 |
| `/advisor [opus\|pro] [关注点]` | 临时切强模型对当前 `git diff` 做只读红队审阅 |
| `/commit [dry]` | 预览或执行按源码/测试/文档分组的原子提交 |
| `/checkpoint [名称]` & `/rewind` | 标记探索起点，排障结束后一键折叠试错上下文 |
| `/snapshot [备注]` & `/snapshots` & `/restore` | 创建、对比、校验、删除或一键还原 Pi 配置快照 |
| `/memory [search 词\|delete id\|on\|off]` | 查看、搜索、删除持久化记忆事实 |

## License

MIT
