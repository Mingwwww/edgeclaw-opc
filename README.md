# edgeclaw-opc 使用说明

本仓库把 `claude-code-main`、`ui`、memory、router 和 gateway 收敛到一套统一配置。
唯一用户配置入口是 `~/.edgeclaw/config.yaml`。UI、CLI、memory、router 和 gateway 都从这份 YAML 派生运行配置。

## 目录关系

| 路径 | 作用 |
|------|------|
| `~/.edgeclaw/config.yaml` | 唯一用户配置入口 |
| `claude-code-main/` | Bun CLI、本地 Anthropic -> OpenAI 代理、`start.sh` |
| `ui/` | Web UI 前后端 |
| `edgeclaw-memory-core/` | 记忆检索 / 索引核心 |

## 前置条件

- Bun
- Node.js 22+
- npm
- 一条可用的 OpenAI 兼容 API

## 第一步：创建统一 YAML 配置

启动 Web UI 后，进入 `Settings -> Config` 直接编辑 `~/.edgeclaw/config.yaml`。如果文件不存在，点击 `Reveal File` 会创建完整模板。

最小必填配置位于 YAML 的：

- `models.providers.<provider>.baseUrl`
- `models.providers.<provider>.apiKey`
- `models.entries.<model>.name`
- `agents.main.model`

注意：

- OpenAI 兼容 provider 的 `baseUrl` 推荐写到 `/v1`
- Anthropic provider 的 `baseUrl` 写域名根路径
- `agent`、`memory`、`router` 都引用 `models.entries` 里的模型 id，不重复配置 key/url
- UI 返回配置时会 mask secret，保存 masked secret 会保留旧值

## 第二步：安装依赖

```bash
cd claude-code-main
bun install

cd ../ui
npm install
```

## 第三步：启动 Claude Code 链路

```bash
cd claude-code-main
chmod +x start.sh
./start.sh
```

`start.sh` 会读取 `~/.edgeclaw/config.yaml`，派生内部 `OPENAI_*` / `ANTHROPIC_*` 变量，并在需要时自动拉起本地代理。

如果要只运行消息网关，不启动 CLI：

```bash
cd claude-code-main
./start.sh --gateway
```

如果要在正常启动 CLI 的同时后台拉起 gateway，把 YAML 中的 `gateway.enabled` 设为 `true`。

## 第四步：启动 Web UI

```bash
cd ui
npm run dev
```

默认地址：

- Web UI: `http://localhost:5173`
- API Server: `http://localhost:3001`

前端和服务端都会读取 `~/.edgeclaw/config.yaml`；不需要创建任何 `.env` 文件。

## Gateway 配置

gateway 也统一读取 `~/.edgeclaw/config.yaml`，保存后 UI 会重新生成 gateway runtime YAML。

常见入口字段：

- `gateway.enabled`
- `gateway.allowAllUsers`
- `gateway.allowedUsers`
- `gateway.channels.<channel>.enabled`

支持的 channel 在默认 YAML 中都会展示：

- Telegram
- Discord
- Slack
- Feishu / Lark
- WeCom / DingTalk
- Matrix / Signal / Mattermost
- Email / SMS / Home Assistant
- API Server / Webhook / Weixin / WhatsApp

## Memory 配置

memory 默认开启。只有显式设置以下值时才会关闭：

```yaml
memory:
  enabled: false
```

默认情况下，memory 继承主模型：

```yaml
memory:
  model: inherit
```

如果 memory 要独立走另一套模型，先在 `models.providers` / `models.entries` 中定义，再把 `memory.model` 指向该模型 id。

## 常见命令

查看当前配置入口和状态：

```bash
cd ui
node server/cli.js status
```

或：

```bash
cd ui
cloudcli status
```

## Browser-Use (浏览器自动化)

Agent 内置了 `browser-use` MCP 工具，可以驱动 Chrome 进行网页交互。

### 必需依赖

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| Google Chrome | 任意版本 | Playwright 管理模式需要系统安装 Chrome |
| playwright-core | 已内置 | `claude-code-main` 的依赖，`bun install` 时自动安装 |
| Node.js | >= 18 | 运行 UI Server 的 globalChrome 管理器 |

### Chrome 搜索路径

程序按顺序查找 Chrome 可执行文件：

**macOS:**
1. `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
2. `/Applications/Chromium.app/Contents/MacOS/Chromium`
3. `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`

**Linux:**
1. `/usr/bin/google-chrome`
2. `/usr/bin/chromium-browser`
3. `/usr/bin/chromium`

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CDP_URL` | 自动管理 | 外部 Chrome CDP 地址，一般无需手动设置 |
| `BROWSER_HEADLESS` | `0` | 设为 `1` 强制 headless 模式 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Chrome 用户数据和锁文件的父目录 |

### 容器 / 无 GUI 服务器部署

在没有桌面环境的 Linux 机器或 Docker 容器中，浏览器会自动切换到 headless 模式（检测 `DISPLAY` 环境变量或 `BROWSER_HEADLESS=1`）。

如果需要在容器中运行非 headless 浏览器（例如调试用途），需要：

1. 安装 Xvfb 和 Chrome 系统库：
   ```bash
   apt-get install -y xvfb google-chrome-stable \
     libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
     libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
     libxrandr2 libgbm1 libpango-1.0-0 libasound2
   ```
2. 在启动命令前加 `xvfb-run`，或设置 `DISPLAY=:99` 并后台运行 `Xvfb :99`

### Chrome 版本兼容性

Chrome 147+ 与 Playwright 的 `connectOverCDP` 存在已知不兼容（`setDownloadBehavior` 协议变更）。程序会自动检测 Chrome 版本，对 >= 147 的 Chrome 跳过 CDP 连接，改用 Playwright 直接管理浏览器，无需手动干预。

### 常见故障排查

| 现象 | 可能原因 | 解决方案 |
|------|---------|---------|
| "Chrome not found" | 系统未安装 Chrome | 安装 Chrome 或 Chromium |
| 浏览器打开后无响应 | Chrome 147+ CDP 不兼容 | 已自动修复，确保使用最新代码 |
| 容器中启动失败 | 缺少 `DISPLAY` 或 headless 未启用 | 设置 `BROWSER_HEADLESS=1` 或安装 Xvfb |
| "failed to acquire lock" | 上次异常退出残留锁文件 | 删除 `~/.claude/browser-use-profile/chrome-cdp.lock` |
| 端口 9222 被占用 | 其他 Chrome 实例占用 CDP 端口 | `lsof -ti :9222 \| xargs kill` |

## 安全说明

- 用户密钥只放在 `~/.edgeclaw/config.yaml`
- 不要把密钥写进任何 `VITE_*` 变量
- API 返回给 UI 的 secret 会被 mask；保存 masked secret 会保留原值
