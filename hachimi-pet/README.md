<div align="center">
  <img src="./assets/logo.png" alt="Hachimi Starry Catgirl Logo" width="128" height="128" />
  <h1>Hachimi Pet (`hachimi-pet`)</h1>
  <p><strong>轻量级 Antigravity 哈基米桌面伴侣插件 · Lightweight Starry Catgirl Desktop Pet HUD for Google Antigravity</strong></p>

  <p>
    <a href="#license"><img src="https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg" alt="License: AGPL-3.0-or-later" /></a>
    <img src="https://img.shields.io/badge/Antigravity-Plugin%20(Hooks%20%2B%20MCP%20%2B%20Skill)-purple.svg" alt="Antigravity Plugin" />
    <img src="https://img.shields.io/badge/Zero%20Runtime%20Deps-~9.4%20MB-emerald.svg" alt="Zero Runtime Deps" />
    <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg" alt="Cross Platform" />
  </p>
</div>

---

## ✨ 特性亮点 · Highlights

- **透明桌面悬浮 HUD**：无边框透明贴边悬浮，呈现哈基米本体、实时思考/状态气泡与上下文吞吐徽章；配色、大小、透明度、自由漫步、音效与穿透锁定统一通过系统托盘控制。
- **毫秒级自动对接当前对话（`<100ms`）**：实时监听 Antigravity 会话目录（`annotations/*.pbtxt`、SQLite `conversation_summaries` 与增量 `transcript.jsonl`），切换标签页或新开对话时自动切换对接，并自动过滤子代理避免误抢焦点。
- **原生精度上下文环 & 吞吐率监控**：
  - 头顶实时显示 **上下文窗口占用环**（绿色 `<62%` / 琥珀 `≥62%` / 红色 `≥85%`），悬停展示精确 `used / limit (%)`。
  - 自动识别 `/compact`（`CHECKPOINT`）压缩事件，压缩完成瞬间回落为压缩后摘要 token 大小并标记「已压缩」。
  - 右侧实时展示生成速度（`tok/s`），悬停可查看 **综合速率 · 流式速率 · TTFT 首字延迟 · 输出 Token 数**。
- **全形态哈基米（8 套专属配色 × 同源子代理外观）**：
  - 全部 8 套配色共享哈基米角色模型与物理骨骼：`astral`（星瞳紫）、`sakura`（樱粉）、`azure`（蔚蓝）、`emerald`（翡翠）、`amber`（琥珀）、`crimson`（绯红）、`arctic`（冰银）、`obsidian`（曜黑）。
- **子代理天降 & 蜂群（Swarm）睡眠联动**：
  - 支持单子代理、`teamwork`、`/swarm` 多智能体并发：主会话派生成员时，不同配色的小猫娘自动天降落位并与各自进度气泡绑定。
  - **Swarm 休眠动作同步**：成员进入 `waiting` / 休息状态（`swarm_wait`）时对应猫娘自动蜷缩进入睡眠动作（`z Z z`）；被 `@mention` 唤醒后立刻醒来；任务完成后平滑 `0.45s` 淡出退场。
- **桌面点击穿透安全锁**：像素级命中检测 + `Alt + Shift + W` 全局穿透锁定，绝不遮挡桌面或 IDE 正常操作。
- **零重型依赖架构**：插件包仅 ~`9.9 MB`，Windows 10/11 直接调用系统内置 **Edge WebView2 + `0.83 MB` 原生轻壳**，**无需下载 269 MB Electron 运行时**；非 Windows 平台仍自动兼容回退至 Electron。

---

## 🚀 安装与使用 · Installation & Quick Start

### 方式一：本地安装为全局 Antigravity 插件

将本仓库目录（`hachimi-pet`）复制或链接到 Antigravity 全局插件目录即可生效：

**Windows (PowerShell):**
```powershell
git clone https://github.com/hwt675217/hachimi-pet.git "$env:TEMP\hachimi-pet-repo"
Copy-Item -Recurse -Force "$env:TEMP\hachimi-pet-repo\hachimi-pet" "$HOME\.gemini\config\plugins\hachimi-pet"
```

**macOS / Linux:**
```bash
git clone https://github.com/hwt675217/hachimi-pet.git /tmp/hachimi-pet-repo
mkdir -p ~/.gemini/config/plugins
cp -R /tmp/hachimi-pet-repo/hachimi-pet ~/.gemini/config/plugins/hachimi-pet
```

> 或直接在克隆仓库根目录运行 `agy plugin install ./hachimi-pet`。

校验插件完整性（可选）：
```bash
agy plugin validate ~/.gemini/config/plugins/hachimi-pet --strict --json
```

### 方式二：从 Antigravity Marketplace 安装（发布后）
在 Antigravity 插件市场中搜索 **`hachimi-pet`**（或 **Hachimi Starry Catgirl HUD**），点击安装并启用即可。

---

## 💬 使用方式 · Usage

1. 在 Antigravity 对话框输入斜杠命令：
   ```text
   /hachimi
   ```
   桌宠将自动后台拉起（首次启动时若系统未安装全局 Electron，会自动将 `electron@33.3.1` 单次缓存至 `~/.hachimi-pet/runtime`）。
2. 在 Antigravity 对话期间，模型也可按需调用 MCP 工具 `hachimi_pet_notify` 主动向你挥手、点头、跳舞或发送气泡消息，而**生命周期 Hooks 与增量日志监听器**会自动保持实时进度与指标同步，不会阻塞对话结束。
3. **系统托盘菜单**（右键任务栏托盘图标）：
   - 切换 8 套哈基米配色
   - 调整桌宠大小（`50%`–`110%`）与透明度（`40%`–`100%`），设置自动保存
   - 开关自由漫步（Free Roam）/ 语音音效
   - 一键锁定/解锁桌面穿透（快捷键 `Alt + Shift + W`）
   - 召唤测试子代理猫娘演示天降与退场效果
   - 随时退出或置顶桌宠

---

## 🧩 插件结构 · Plugin Layout

```text
hachimi-pet/
├── plugin.json                 # Antigravity 插件清单（name/logo/suggestedPrompts）
├── hooks.json                  # SessionStart / PreInvocation / PreToolUse / PostToolUse / PostInvocation / Stop
├── mcp_config.json             # 零依赖 MCP Stdio Server（hachimi_pet_notify）
├── assets/
│   └── logo.png                # 256×256 RGBA 透明背景插件图标
├── rules/
│   └── AGENTS.md               # 非阻塞伴侣行为准则
├── skills/
│   └── hachimi/
│       └── SKILL.md            # /hachimi 斜杠命令技能定义
├── sidecars/
│   └── hachimi-pet/
│       ├── sidecar.json        # Sidecar 守护进程配置
│       └── entry.mjs           # Sidecar 入口
├── scripts/
│   ├── hook-forwarder.mjs      # <75ms 超时兜底的 Hook 转发器
│   ├── launch-pet.mjs          # 跨平台守护拉起与 ~/.hachimi-pet/runtime 缓存引导
│   └── mcp-server.mjs          # 纯 Node MCP Server
├── app/
│   ├── package.json            # 桌面宿主入口声明（0 runtime npm 依赖）
│   ├── dist/                   # Vite + React 生产前端包与哈基米骨骼纹理资源
│   ├── shell-win32/            # Windows 原生 WebView2 轻量透明穿透壳（~0.83 MB）
│   └── electron/               # 纯 Node 桥接引擎（webview2-host.cjs）与非 Windows Electron 兼容回退
├── LICENSE                     # GNU AGPL-3.0-or-later
├── THIRD_PARTY_NOTICES.md      # 第三方开源组件与语音字库声明
└── README.md
```

---

## ⚙️ 环境要求 · Requirements

- **Node.js `>= 18`**（Antigravity Hooks / MCP Server 与纯 Node 桥接服务使用系统 `node`）
- **Python 3**（可选但推荐：用于只读查询 Antigravity 会话 `.db` 精确上下文窗口统计）
- **Windows 10 / 11**：**免下载、开箱即用**——直接复用系统自带 **Microsoft Edge WebView2** 运行时（仅附带 `0.83 MB` 原生宿主壳，彻底告别 269 MB Electron）
- **macOS / Linux**：首次运行 `/hachimi` 时自动定位或按需缓存 Electron 到 `~/.hachimi-pet/runtime`（Windows 如需强制使用 Electron，也可设置环境变量 `HACHIMI_RUNTIME=electron`）

---

## 🛠️ 本地开发与构建 · Development

插件源码工作区位于 `agy-hachimi-pet/`（如果你克隆的是完整源码仓库）：

```bash
cd agy-hachimi-pet
npm install
npm run dev           # 启动 Vite + Electron 热重载调试
npm run build:plugin  # 编译生产包并同步生成便携插件 hachimi-pet/app/
```

---

## 📄 开源协议与致谢 · License & Credits

- 本项目依据 **GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`)** 开源，详见 [LICENSE](./LICENSE)。
- 桌面宠物理骨骼引擎与部分音频组件衍生自 **Coopanion**（AGPL-3.0-or-later），第三方字库/开源声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
- 角色美术图层（8 套哈基米外观）与 Antigravity 多智能体同步层为本项目定制构建，不含第三方商业厂商商标。
