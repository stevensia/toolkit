# Claude Code 快速配置指南

> Claude Code **2.1.71** | 需要 Node.js ≥ 18

---

## 当前配置

| 项目 | 值 |
|---|---|
| 代理地址 | `http://localhost:4399` |
| 主模型 | `claude-opus-4.6-1m` |
| MCP | Tavily 搜索 |
| 插件 | context7, code-review, github, playwright, typescript-lsp, frontend-design |

配置文件位置：`~/.claude/settings.json` + `~/.claude/mcp.json`

---

## 安装

```bash
# Linux
sudo npm install -g @anthropic-ai/claude-code

# Windows (PowerShell 管理员)
npm install -g @anthropic-ai/claude-code

# Windows 推荐用 WSL2，体验与 Linux 一致
wsl --install -d Ubuntu-24.04
```

---

## 核心配置

### settings.json

Linux 路径：`~/.claude/settings.json`
Windows 路径：`%USERPROFILE%\.claude\settings.json`

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4399",
    "API_TIMEOUT_MS": "3000000",
    "ANTHROPIC_MODEL": "claude-opus-4.6-1m",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-opus-4.6-1m",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4.5",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-opus-4.6-1m",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-opus-4.6-1m",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "allow": [
      "Bash(*)", "Read(*)", "Write(*)", "Edit(*)",
      "Glob(*)", "Grep(*)", "WebFetch(*)", "WebSearch(*)",
      "Agent(*)", "NotebookEdit(*)"
    ],
    "deny": [
      "Bash(rm -rf /)", "Bash(rm -rf /*)",
      "Bash(Remove-Item -Recurse -Force C:\\*)",
      "Bash(format *:)", "Bash(diskpart*)"
    ]
  },
  "model": "opus",
  "enabledPlugins": {
    "frontend-design@claude-plugins-official": true,
    "context7@claude-plugins-official": true,
    "code-review@claude-plugins-official": true,
    "github@claude-plugins-official": true,
    "playwright@claude-plugins-official": true,
    "typescript-lsp@claude-plugins-official": true
  }
}
```

**env 字段说明：**

| 变量 | 用途 |
|---|---|
| `ANTHROPIC_BASE_URL` | API 代理地址，直连 Anthropic 则删除此项 |
| `ANTHROPIC_AUTH_TOKEN` | 认证 Token，直连时填 `sk-ant-xxx` |
| `API_TIMEOUT_MS` | API 超时（ms），`3000000` = 50 分钟，防长任务断开 |
| `ANTHROPIC_MODEL` | 主模型，使用原生模型名 `claude-opus-4.6-1m` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | 内部 Sonnet 调用替换为指定模型 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | 内部 Opus 调用替换为指定模型 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | 内部 Haiku 调用替换为指定模型 |
| `ANTHROPIC_SMALL_FAST_MODEL` | 内部快速模型替换 |
| `DISABLE_NON_ESSENTIAL_MODEL_CALLS` | `1` = 省钱，禁用非核心调用 |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` = 禁用遥测流量 |

**permissions 规则：** `deny` 优先于 `allow`。语法为 `工具名(glob模式)`。deny 已覆盖 Linux（`rm -rf`）和 Windows（`Remove-Item`/`format`/`diskpart`）。

**enabledPlugins：** 官方插件，按需开关。

| 插件 | 用途 |
|---|---|
| `context7` | 自动拉取第三方库最新文档作为上下文 |
| `code-review` | 代码审查 |
| `github` | GitHub 集成 |
| `playwright` | 浏览器自动化测试 |
| `typescript-lsp` | TypeScript 语言服务 |
| `frontend-design` | 前端设计辅助 |

### mcp.json

同目录下 `~/.claude/mcp.json`（Windows: `%USERPROFILE%\.claude\mcp.json`）：

```json
{
  "mcpServers": {
    "tavily": {
      "type": "url",
      "url": "https://mcp.tavily.com/mcp/?tavilyApiKey=<YOUR_KEY>"
    }
  }
}
```

---

## Windows PowerShell 一键部署

以管理员打开 PowerShell，直接运行：

```powershell
# 1. 安装
npm install -g @anthropic-ai/claude-code

# 2. 创建配置目录
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude" | Out-Null

# 3. 写入 settings.json（内容同上方"核心配置"）
@'
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4399",
    "API_TIMEOUT_MS": "3000000",
    "ANTHROPIC_MODEL": "claude-opus-4.6-1m",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-opus-4.6-1m",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4.5",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-opus-4.6-1m",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-opus-4.6-1m",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "allow": [
      "Bash(*)", "Read(*)", "Write(*)", "Edit(*)",
      "Glob(*)", "Grep(*)", "WebFetch(*)", "WebSearch(*)",
      "Agent(*)", "NotebookEdit(*)"
    ],
    "deny": [
      "Bash(rm -rf /)", "Bash(rm -rf /*)",
      "Bash(Remove-Item -Recurse -Force C:\\*)",
      "Bash(format *:)", "Bash(diskpart*)"
    ]
  },
  "model": "opus",
  "enabledPlugins": {
    "frontend-design@claude-plugins-official": true,
    "context7@claude-plugins-official": true,
    "code-review@claude-plugins-official": true,
    "github@claude-plugins-official": true,
    "playwright@claude-plugins-official": true,
    "typescript-lsp@claude-plugins-official": true
  }
}
'@ | Set-Content -Encoding utf8NoBOM -Path "$env:USERPROFILE\.claude\settings.json"

# 4. 写入 mcp.json
@'
{
  "mcpServers": {
    "tavily": {
      "type": "url",
      "url": "https://mcp.tavily.com/mcp/?tavilyApiKey=<YOUR_KEY>"
    }
  }
}
'@ | Set-Content -Encoding utf8NoBOM -Path "$env:USERPROFILE\.claude\mcp.json"

# 5. 验证
claude --version
```

---

## Linux 一键部署

```bash
# 1. 安装
sudo npm install -g @anthropic-ai/claude-code

# 2. 写入配置（settings.json 和 mcp.json 内容见上方"核心配置"）
mkdir -p ~/.claude
# 将上方 settings.json 内容写入 ~/.claude/settings.json
# 将上方 mcp.json 内容写入 ~/.claude/mcp.json

# 3. 验证
claude --version
```

---

## 可选文件

| 文件 | 位置 | 用途 |
|---|---|---|
| `CLAUDE.md` | 项目根目录 | 项目级指令（技术栈、构建命令等） |
| `CLAUDE.md` | `~/.claude/` | 全局指令（语言偏好等） |
| `.claude/settings.json` | 项目根目录 | 项目级权限覆盖，优先级高于用户级 |

**配置优先级：** 命令行参数 > 环境变量 > 项目级 settings > 用户级 settings
