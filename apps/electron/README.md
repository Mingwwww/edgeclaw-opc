# EdgeClaw Electron App

将 edgeclaw-test-0422 打包为 macOS App。

## 项目结构

```
apps/electron/
├── src/
│   ├── main.js          # Electron 主进程
│   ├── index.html       # 加载界面
│   └── preload.js       # IPC 桥接
├── resources/
│   └── entitlements.mac.plist  # macOS 权限
├── package.json
└── electron-builder.yml
```

## 构建

```bash
cd apps/electron

# 安装依赖
npm install

# 打包 App（--dir 生成 .app，不生成 DMG）
npx electron-builder --mac --dir
```

## App 输出

```
dist-electron/
├── mac-arm64/EdgeClaw.app   # App bundle (~1.6GB)
└── EdgeClaw.dmg              # DMG 安装包
```

## 架构说明

### 打包内容

electron-builder 打包以下内容到 App:
- `src/` - Electron 主进程代码
- `claude-code-main/` - Claude Code CLI
- `claudecodeui/dist/` - React 前端构建
- `claudecodeui/server/` - Express 服务器
- `claudecodeui/node_modules/` - 服务器依赖（~694MB）
- `edgeclaw-memory-core/` - 内存服务
- `config/` - 配置文件
- `.env` - 环境变量

### 为什么 App 这么大

node_modules 是 694MB（包含 SQLite 原生模块、Express、Vite 等）。asar 压缩后 App 约 1.6GB。

### 运行流程

1. Electron 启动
2. 使用 `process.execPath`（Electron 内置 Node.js）启动服务器
3. 服务器在 `localhost:3001` 运行
4. Electron 窗口加载 `http://localhost:3001/?uiV2=1`

### macOS Sandbox 限制

macOS sandbox 阻止 Electron app 启动外部二进制，所以：
- ❌ 不能用 `/usr/local/bin/node`
- ❌ 不能用 `/opt/homebrew/bin/bun`
- ✅ 可以用 `process.execPath`（Electron 自带的 Node.js）

### Bun 编译限制

尝试用 `bun build --compile` 打包服务器失败：
- ❌ `node:sqlite` 模块不支持
- ✅ `bun:sqlite` 可用但需要修改代码

## 测试

```bash
# 清理旧进程
killall -9 "EdgeClaw" 2>/dev/null

# 打开 App
open dist-electron/mac-arm64/EdgeClaw.app

# 查看日志
cat /tmp/edgeclaw-webui.log
```

## 创建 DMG

```bash
APP_PATH="dist-electron/mac-arm64/EdgeClaw.app"
DMG_PATH="dist-electron/EdgeClaw.dmg"
TMP_DMG=$(mktemp -d)

ditto "$APP_PATH" "$TMP_DMG/EdgeClaw.app"
ln -sf /Applications "$TMP_DMG/Applications"

APP_MB=$(du -sm "$TMP_DMG/EdgeClaw.app" | awk '{print $1}')
ALLOC=$((APP_MB + 200))

hdiutil create -volname "EdgeClaw" \
  -srcfolder "$TMP_DMG" -ov -fs APFS -format ULMO \
  -size "${ALLOC}m" "$DMG_PATH"

rm -rf "$TMP_DMG"
```

## 已知问题

1. **配置文件缺失**: 运行时可能需要 `config/api-config.json`
2. **认证**: Web UI 需要登录认证
3. **App 大小**: 1.6GB 对于分发可能太大

## 后续优化方向

1. **减小体积**: 排除不需要的 node_modules
2. **bun 编译**: 将 `node:sqlite` 替换为 `bun:sqlite`
3. **外部服务器**: App 连接远程服务器而非本地
4. **pkg 打包**: 尝试用 pkg 打包服务器为单一可执行文件