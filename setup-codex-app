# Codex App Hybrid Auth Setup Guide

> **目标**: 配置 OpenAI Codex App，使用 ChatGPT 账号登录（保留官方功能），同时将模型推理路由到第三方代理 API。
>
> **适用平台**: Windows
>
> **前置条件**: Codex App 已安装，有 ChatGPT/GPT 账号，有可用的 API 代理服务

---

## 原理

Codex App 有两个独立子系统：

```
┌─────────────┐      ┌──────────────┐      ┌──────────────────┐
│  Codex App  │─────>│  auth.json   │─────>│  OpenAI OAuth    │
│  (UI/功能)  │      │  认证层       │      │  ChatGPT 登录    │
└─────────────┘      └──────────────┘      └──────────────────┘
       │
       v
┌─────────────┐      ┌──────────────┐      ┌──────────────────┐
│  模型推理    │─────>│  config.toml │─────>│  代理 / API      │
│  请求        │      │  推理层       │      │  (base_url)      │
└─────────────┘      └──────────────┘      └──────────────────┘
```

- **认证层** (`auth.json`): `auth_mode: "chatgpt"` 保持官方 OAuth 登录，提供远程控制、插件、配额显示等功能
- **推理层** (`config.toml`): `model_provider` 指向代理地址，实际模型调用走代理
- **桥接**: `requires_openai_auth = true` 将 OAuth token 传递给代理，保持身份验证链路

---

## 关键路径

| 文件 | 路径 |
|------|------|
| auth.json | `%USERPROFILE%\.codex\auth.json` |
| config.toml | `%USERPROFILE%\.codex\config.toml` |
| 备份目录 | `%USERPROFILE%\.codex-backup-*` |

---

## 操作步骤

### Step 1: 检测当前状态

```powershell
# 检查 .codex 目录是否存在
Test-Path "$env:USERPROFILE\.codex"

# 查看 auth.json
Get-Content "$env:USERPROFILE\.codex\auth.json" | ConvertFrom-Json | Select-Object auth_mode

# 查看 config.toml 关键字段
Select-String -Path "$env:USERPROFILE\.codex\config.toml" -Pattern "model_provider|base_url|requires_openai_auth|wire_api|^model "
```

预期输出分析：
- `auth_mode = "apikey"` → 需要切换到 chatgpt 模式（Step 4）
- `auth_mode = "chatgpt"` → 认证已就绪
- 无 `base_url` → 需要配置代理（Step 3）

### Step 2: 备份

```powershell
$backupDir = "$env:USERPROFILE\.codex-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Copy-Item "$env:USERPROFILE\.codex\auth.json" "$backupDir\auth.json"
Copy-Item "$env:USERPROFILE\.codex\config.toml" "$backupDir\config.toml"
Write-Host "Backed up to: $backupDir"
```

### Step 3: 配置代理 Provider

编辑 `%USERPROFILE%\.codex\config.toml`，在文件顶部设置：

```toml
model_provider = "<PROVIDER_NAME>"
model = "<MODEL_NAME>"
```

并添加对应的 provider 配置块：

#### 方案 A: 本地 copilot-proxy（使用 GitHub Copilot 订阅）

```toml
model_provider = "copilot_proxy"
model = "gpt-5.5"

[model_providers.copilot_proxy]
name = "Copilot Proxy"
base_url = "http://127.0.0.1:4400/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

安装和启动 copilot-proxy：

```powershell
# 安装
npm i -g @jer-y/copilot-proxy

# 启动（守护进程模式）
npx @jer-y/copilot-proxy@latest start -d --port 4400

# 查看状态
npx @jer-y/copilot-proxy@latest status

# 实时日志
npx @jer-y/copilot-proxy@latest logs -f
```

#### 方案 B: 第三方代理（sub2api / latix / 自建等）

```toml
model_provider = "my_proxy"
model = "gpt-5.5"

[model_providers.my_proxy]
name = "My Proxy"
base_url = "https://your-proxy-url.com/v1"
experimental_bearer_token = "sk-your-api-key"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

> **注意**: 修改 config.toml 时保留所有其他已有配置段（`[marketplaces.*]`, `[plugins.*]`, `[projects.*]` 等），只修改/添加顶部字段和 `[model_providers.*]` 块。

### Step 4: 切换认证到 ChatGPT

> ⚠️ 此步骤需要用户手动操作 GUI

**提示用户执行以下操作**：

1. 打开 Codex App
2. 退出当前登录（如果是 API key 模式）
3. 选择 ChatGPT/GPT 账号登录（支持 Google、Microsoft、邮箱）
4. 登录成功后，**关闭 Codex App**

**登录完成后验证**：

```powershell
# 验证 auth_mode 已切换
$auth = Get-Content "$env:USERPROFILE\.codex\auth.json" -Raw | ConvertFrom-Json
Write-Host "auth_mode: $($auth.auth_mode)"
Write-Host "has_tokens: $($null -ne $auth.tokens)"
if ($auth.tokens) {
    Write-Host "account_id: $($auth.tokens.account_id)"
}
```

预期结果：`auth_mode: chatgpt`，`has_tokens: True`

**重要**: 登录后检查 config.toml 是否被 Codex App 重置：

```powershell
Select-String -Path "$env:USERPROFILE\.codex\config.toml" -Pattern "model_provider|base_url"
```

如果 `model_provider` 或 `base_url` 被还原，从备份恢复或重新执行 Step 3。

### Step 5: 验证代理运行

```powershell
# 检查代理端口是否在监听（以 4400 为例）
netstat -ano | Select-String ":4400\s.*LISTENING"

# 测试代理响应
Invoke-RestMethod -Uri "http://127.0.0.1:4400/v1/models" -Method GET -TimeoutSec 5 |
    Select-Object -ExpandProperty data |
    Select-Object -First 10 id
```

### Step 6: 端到端验证

```powershell
# 一次性全面检查
$auth = Get-Content "$env:USERPROFILE\.codex\auth.json" -Raw | ConvertFrom-Json
$configRaw = Get-Content "$env:USERPROFILE\.codex\config.toml" -Raw

$checks = @(
    @{ Name = "auth_mode = chatgpt";       Pass = ($auth.auth_mode -eq "chatgpt") }
    @{ Name = "has OAuth tokens";          Pass = ($null -ne $auth.tokens) }
    @{ Name = "config has base_url";       Pass = ($configRaw -match 'base_url\s*=\s*"[^"]+"') }
    @{ Name = "requires_openai_auth=true"; Pass = ($configRaw -match 'requires_openai_auth\s*=\s*true') }
)

# 检查代理端口
$proxyUp = $false
if ($configRaw -match 'base_url\s*=\s*"[^"]*:(\d+)') {
    $port = $Matches[1]
    $proxyUp = [bool](netstat -ano | Select-String ":$port\s.*LISTENING")
    $checks += @{ Name = "Proxy on port $port"; Pass = $proxyUp }
}

$checks | ForEach-Object {
    $icon = if ($_.Pass) { "PASS" } else { "FAIL" }
    Write-Host "[$icon] $($_.Name)"
}
```

全部显示 `[PASS]` 即配置完成。打开 Codex App 发送一条测试消息验证。

---

## 故障排查

| 问题 | 解决方案 |
|------|----------|
| Token 过期 / 功能异常 | 重新打开 Codex App，它会自动刷新 OAuth token |
| 登录后 config.toml 被重置 | 从备份恢复 config.toml 或重新配置 provider |
| 代理无响应 | `copilot-proxy status` 检查，`start -d` 重启 |
| 模型不匹配报错 | `curl http://127.0.0.1:4400/v1/models` 查看可用模型，修改 config.toml 中的 `model` 字段 |
| 远程控制 / 插件失效 | 确认 `requires_openai_auth = true` 且 `auth_mode = "chatgpt"` |
| 代理日志查看 | `npx @jer-y/copilot-proxy@latest logs -f` |

---

## 风险提示

- **合规**: 此方案可能违反 OpenAI 使用条款，有账号封禁风险
- **数据安全**: 第三方代理可能截获代码和 prompt，生产环境慎用
- **稳定性**: 第三方代理服务可能随时下线
- **备份**: 操作前务必备份 `.codex` 目录
