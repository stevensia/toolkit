# Claude Code 快速配置指南

> Claude Code **2.1.71** | 需要 Node.js ≥ 18

---

## 当前配置

| 项目 | 值 |
|---|---|
| Node.js | v22.22.1 |
| 代理地址 | `http://localhost:4399` |
| 主模型 | `opus[1m]` |
| MCP | Tavily 搜索 |

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
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "opus",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4.1",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1",
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
      "Bash(rm -rf /boot*)", "Bash(rm -rf /etc*)",
      "Bash(rm -rf /bin*)", "Bash(rm -rf /sbin*)",
      "Bash(rm -rf /lib*)", "Bash(rm -rf /usr*)",
      "Bash(rm -rf /var*)", "Bash(rm -rf /sys*)",
      "Bash(rm -rf /proc*)", "Bash(rm -rf /dev*)",
      "Bash(dd if=* of=/dev/sd*)", "Bash(dd if=* of=/dev/nvme*)",
      "Bash(mkfs*)", "Bash(fdisk*)", "Bash(parted*)",
      "Write(/boot/*)", "Write(/etc/passwd)", "Write(/etc/shadow)", "Write(/etc/sudoers)",
      "Edit(/boot/*)", "Edit(/etc/passwd)", "Edit(/etc/shadow)", "Edit(/etc/sudoers)"
    ]
  },
  "model": "opus[1m]"
}
```

**env 字段说明：**

| 变量 | 用途 |
|---|---|
| `ANTHROPIC_BASE_URL` | API 代理地址，直连 Anthropic 则删除此项 |
| `ANTHROPIC_AUTH_TOKEN` | 认证 Token，直连时填 `sk-ant-xxx` |
| `ANTHROPIC_MODEL` | 主模型 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | 内部 Sonnet 调用替换为指定模型 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | 内部 Haiku 调用替换为指定模型 |
| `ANTHROPIC_SMALL_FAST_MODEL` | 内部快速模型替换 |
| `DISABLE_NON_ESSENTIAL_MODEL_CALLS` | `1` = 省钱，禁用非核心调用 |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` = 禁用遥测流量 |

**permissions 规则：** `deny` 优先于 `allow`。语法为 `工具名(glob模式)`。

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

# 3. 写入 settings.json
@'
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4399",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "opus",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4.1",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1",
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
  "model": "opus[1m]"
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

> **注意：** Windows deny 规则用 `Remove-Item`/`format`/`diskpart` 替代 Linux 的 `rm`/`mkfs`/`fdisk`。

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
