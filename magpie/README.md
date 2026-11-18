# Magpie 联网搜索插件：Microsoft Web IQ 接入与部署指南

> 通过 Magpie 原生插件 `search` Hook 将 **[Microsoft Web IQ](https://webiq.microsoft.ai/)**（`POST https://api.microsoft.ai/v3/search/web`）接入 Magpie「设置 › 模型 › 联网搜索」，为自身不具备原生联网搜索能力的模型（如 Azure / Foundry Claude、部分 Chat Completions 模型、公网 Web 部署的网关模型）提供实时网页检索与引用（Grounding）能力。

---

## 目录

- [1. 原理与客户端影响范围](#1-原理与客户端影响范围)
- [2. 核心设计说明](#2-核心设计说明)
- [3. 安装步骤（Windows / macOS / Linux 服务端通用）](#3-安装步骤windows--macos--linux-服务端通用)
- [4. 配置、轮换与更新 API Key](#4-配置轮换与更新-api-key)
- [5. 高级参数自定义（可选）](#5-高级参数自定义可选)
- [6. 功能验证与端到端测试](#6-功能验证与端到端测试)
- [7. Microsoft Web IQ 官方参考文档](#7-microsoft-web-iq-官方参考文档)

---

## 1. 原理与客户端影响范围

Magpie 网关处理联网搜索时遵循 **“上游原生搜索优先，Magpie 搜索按需兜底”** 的两层机制：

1. **第一层（上游原生判断）**：如果当前请求命中的模型通道自身原生支持服务端联网搜索（例如 OpenAI / ChatGPT `/v1/responses`、GitHub Copilot `/v1/responses`、Claude 官方订阅原生搜索等），Magpie 会直接透传搜索工具给上游原生执行，**不会强制覆盖为外部搜索 API**。
2. **第二层（Magpie 搜索兜底）**：只有当目标模型通道**不支持原生联网搜索**、但客户端请求携带了搜索工具或参数时，Magpie 才接管搜索执行。将 `searchFirst` 设为 `api` 后，Magpie 会优先调用已配置的 **Microsoft Web IQ** 搜索接口，而不会借用其他大模型订阅额度代搜。

### 各客户端影响矩阵

| 客户端 / 场景 | 是否经过 Magpie 搜索插件 | 实际行为说明 |
| --- | --- | --- |
| **GitHub Copilot CLI** | 否（零影响） | 使用内置 `web_search` 工具与直连通道，不经过 Magpie 搜索层。 |
| **Codex / ChatGPT 原生通道**<br>（或 Copilot `/v1/responses` 模型） | 否（保持原生） | 上游协议原生支持 `web_search`，Magpie 自动透传给上游原生搜索，互不干扰。 |
| **Claude Code**<br>（路由至 Foundry / Azure / Remote Magpie / 无原生搜索的 Chat 模型） | **是（自动接管）** | Claude Code 发起 `web_search_20250305` 时，Magpie 自动调用 Microsoft Web IQ 检索并拼装标准 `server_tool_use` + `web_search_tool_result` 引用块返回模型。 |
| **公网 / Web 部署的 Magpie**<br>（Open WebUI、Cherry Studio、`/v1/chat/completions` `web_search_options`、`magpie mcp`） | **是（统一提供）** | 前端开启联网搜索但后端模型无自带搜索时，由服务端 Magpie 统一调用 Microsoft Web IQ 完成实时网页 Grounding。 |

---

## 2. 核心设计说明

插件文件位于 [`./webiq.js`](./webiq.js)，针对 Microsoft Web IQ v3 规范做了以下专门适配：

- **零密钥硬编码**：插件源码不包含任何密钥；`x-apikey` 独立存储在 Magpie 的搜索密钥配置中，日志与 CLI 列表自动脱敏显示。
- **`contentFormat: "passage"` 语义段落优化**：
  - Web IQ Playground 在开通 Full Document Access 的 Profile 下默认生成 `"contentFormat": "html", "maxLength": 10000`，但整页 HTML 前部往往包含大量导航栏与标签噪音，容易占满网关单条搜索结果的上下文裁剪窗口。
  - 本插件默认采用官方推荐用于 LLM Grounding 的 `"contentFormat": "passage", "maxLength": 3000, "safeSearch": "strict"`，由 Web IQ 服务端直接提取与 Query 最相关的精炼语义段落，**同时兼容开通或未开通全文权限的所有 App Profile**。
- **中英文查询自适应**：默认不写死 `language: "en"` / `region: "US"`，保留服务端自动语种与意图识别，实测纯中文与纯英文查询均可返回高相关性权威来源。
- **鉴权规范防护**：
  - 默认以 `x-apikey: <YOUR_WEBIQ_API_KEY>` 请求头鉴权，并自动剔除 URL 中可能误带的 `APPID` 查询参数（Web IQ 规范规定：API Key 鉴权携带 `APPID` 参数——即使为空——也会返回 `401 AuthUnauthorizedEntryId`）。
  - 同时兼容 `Bearer <token>` 或 Entra ID OAuth 2.0 JWT 令牌，后续从试用 API Key 迁移到 Entra ID 鉴权无需修改代码。
- **限流冷却与多 Key 故障转移**：解析 Web IQ 标准错误响应（`errorCode`、`userMessage`、`technicalDetails`、`retryAfter`、`traceId`），自动将 `"60s"` 等时长格式标准化后连同 HTTP 状态码（`401` / `403` / `429`）抛回 Magpie 宿主，触发内置的故障 Key 自动冷却与多 Key 轮换。
- **Windows 过期 / 临期自动弹窗换 Key 助手**（Linux 服务端自动降级为日志告警）：
  - **双触发条件**：① Web IQ 返回 `HTTP 401`（Key 过期/失效）时立即弹出（带 10 分钟并发防抖，避免连环弹窗）；② 距离到期日 **≤ 3 天** 时在搜索完成后后台每日温和提醒 1 次。
  - **一键闭环换 Key**：弹窗内置 **「1. 打开 Web IQ Profiles 页面生成新 Key」** + **「粘贴新 Key」** + **「验证并更新到 Magpie」**，保存前先向 Web IQ 实测验证有效性，验证通过后自动调用本机 `magpie.exe search add webiq-js:web <NEW_KEY>` 原地热更新并记录下一个 30 天周期。
  - **本地状态零明文**：同目录 `webiq-state.json` 仅保存 Key 的不可逆 SHA-256 前 12 位指纹与到期日期，绝不落盘明文密钥。

---

## 3. 安装步骤（Windows / macOS / Linux 服务端通用）

### 第 1 步：放置插件文件

将 `webiq.js` 复制到 Magpie 配置目录：

- **Linux / macOS**：`~/.config/magpie/webiq.js`
  ```bash
  mkdir -p ~/.config/magpie
  cp ./webiq.js ~/.config/magpie/webiq.js
  ```
- **Windows (PowerShell)**：`%USERPROFILE%\.config\magpie\webiq.js`
  ```powershell
  New-Item -ItemType Directory -Path "$env:USERPROFILE\.config\magpie" -Force | Out-Null
  Copy-Item .\webiq.js "$env:USERPROFILE\.config\magpie\webiq.js" -Force
  ```

### 第 2 步：注册插件并设置搜索策略

```bash
# 1. 注册插件（运行中的 Magpie 会自动热加载）
magpie plugin add ~/.config/magpie/webiq.js

# 2. 当需要 Magpie 执行搜索时，优先调用搜索 API（避免消耗其他模型订阅额度）
magpie settings set searchFirst api

# （可选）如果希望在 API Key 失效/限流时直接报错，彻底禁止回退到其他模型代搜：
# magpie settings set searcher off
```

> **Windows PowerShell 注意事项**：Windows 版 `magpie.exe` 默认安装于 `$env:LOCALAPPDATA\Programs\magpie\magpie.exe`，且编译为 GUI 子系统。在 PowerShell 终端中执行 CLI 子命令查看文本输出时，建议追加管道以捕获标准输出：
> ```powershell
> $magpie = "$env:LOCALAPPDATA\Programs\magpie\magpie.exe"
> & $magpie plugin add "$env:USERPROFILE\.config\magpie\webiq.js" 2>&1 | Out-String
> & $magpie settings set searchFirst api 2>&1 | Out-String
> ```

---

## 4. 配置、轮换与更新 API Key

插件文件名 `webiq.js` 导出 `search.web`，因此在 Magpie CLI 中的服务商 ID 为 **`webiq-js:web`**，在桌面界面中显示为 **`Microsoft Web IQ`**。

可在 [Web IQ Portal - Profiles](https://webiq.microsoft.ai/profiles/) 查看配额、生成或续期 API Key（试用 Key 通常有固定有效期，建议到期前提前添加新 Key 平滑轮换）。

### 方式 A：通过 Magpie 图形界面配置

1. 打开 Magpie 界面 → 进入 **设置（Settings） › 模型（Models） › 联网搜索（Web Search）**。
2. 在搜索 API 列表中找到 **Microsoft Web IQ**（点击右侧链接可直达 `https://webiq.microsoft.ai/profiles/`）。
3. 填入 `<YOUR_WEBIQ_API_KEY>` 并保存，立即热生效。

### 方式 B：Windows 过期自动弹窗一键更换（零命令）

在 Windows 桌面端运行 Magpie 时：
- 当 Key **剩余 ≤ 3 天**（默认按首次使用 +30 天推算，或按 `#expires=YYYY-MM-DD` 指定）或 **返回 `HTTP 401` 过期报错** 时，会自动弹出 **「Magpie · Microsoft Web IQ API Key 更新助手」** 窗口。
- 点击窗口内 **「1. 打开 Web IQ Profiles 页面生成新 Key」** → 复制新 Key → 点击 **「粘贴」** → 点击 **「验证并更新到 Magpie」**，验证通过后立即原地覆盖旧 Key 并热生效。
- 也可随时手动唤起该窗口提前更换：
  ```powershell
  & "$env:USERPROFILE\.cache\magpie\bun\1.4.4\magpie-bun.exe" "$env:USERPROFILE\.config\magpie\webiq.js" --popup
  # 若系统已安装 bun，也可直接运行：bun "$env:USERPROFILE\.config\magpie\webiq.js" --popup
  ```

### 方式 C：通过 CLI 配置与轮换（适合服务器部署或脚本更新）

```bash
# 添加或原地更新单把 API Key（再次执行会自动覆盖旧 Key 并保留原有 url= 配置）
magpie search add webiq-js:web "<YOUR_WEBIQ_API_KEY>"

# 同时配置多把 API Key（自动负载均衡与 401/429 故障切换）
magpie search add webiq-js:web "<KEY_1>,<KEY_2>"

# 查看当前已配置的搜索服务商与脱敏 Key 列表
magpie search
# 示例输出：
#   1. Microsoft Web IQ  xxxx…xxxx=

# 如需彻底移除 Microsoft Web IQ 搜索配置
magpie search rm webiq-js:web
```

---

## 5. 高级参数自定义（可选）

如果需要覆盖默认端点（例如切换备用域名 `https://api.microsoftol.com/v3`）或调整 Web IQ 请求体参数，可在添加 Key 时附带 `url=` 参数，并通过 `#hash` 传入插件选项（`#hash` 仅在本地插件解析，不会拼接到发往 Web IQ 的 HTTP Query String 中）：

```bash
magpie search add webiq-js:web "<YOUR_WEBIQ_API_KEY>" \
  "url=https://api.microsoft.ai/v3#contentFormat=markdown&maxLength=10000&safeSearch=strict&language=zh&region=CN"
```

支持的 `#hash` 参数：

| 参数名 | 默认值 | 可选值 / 说明 |
| --- | --- | --- |
| `contentFormat` | `passage` | `passage`（推荐，通用）、`markdown`、`text`、`html`（后三者需 App Profile 开通全文权限，否则返回 `403 AuthContentFormatForbidden`；选 `html` 时插件会自动剥离脚本与标签）。 |
| `maxLength` | `3000`（`passage`）<br>`10000`（全文） | `1` ~ `500000`（未开通全文权限时服务端上限为 `3000`）。 |
| `safeSearch` | `strict` | `strict` 或 `off`。 |
| `language` | 不传（自动） | ISO 639-1 双字母语言代码，如 `en`、`zh`、`ja`。 |
| `region` | 不传（自动） | 2 字母国家/地区代码，如 `US`、`CN`、`SG`。 |
| `scopeName` | 不传 | 已在 Web IQ 中创建的命名检索范围（Scope）。 |
| `popup` | `on` | 设为 `off` 可关闭 Windows 过期/临期桌面弹窗（Linux 下默认自动跳过 GUI 弹窗）。 |
| `expires` | 自动（首次启用 +30 天） | 显式指定当前 Key 到期日 `YYYY-MM-DD`（例如 `expires=2026-12-18`）。 |
| `ttlDays` | `30` | 新 Key 默认有效期天数（弹窗更新时自动按今天 + `ttlDays` 预填下次到期日）。 |
| `warnDays` | `3` | 到期前提前多少天开始每日提醒一次（`0` ~ `60`）。 |

---

## 6. 功能验证与端到端测试

### 6.1 直接测试搜索工具链路

```bash
# 英文查询测试
magpie tool web_search "Latest AI trends" --count 3

# 中文查询测试
magpie tool web_search "人工智能智能体最新进展" --count 3
```

Windows PowerShell 下：

```powershell
$magpie = "$env:LOCALAPPDATA\Programs\magpie\magpie.exe"
& $magpie tool web_search "Latest AI trends" --count 3 2>&1 | Out-String
```

### 6.2 模拟 Claude Code（Anthropic `/v1/messages` + `web_search_20250305`）端到端测试

向本地或远端 Magpie 网关（默认端口 `3425`）发送携带 `web_search_20250305` 的请求，选择任意本身无原生 Anthropic 搜索的模型验证自动检索与引用生成：

```bash
curl -sS http://127.0.0.1:3425/v1/messages \
  -H "x-api-key: <YOUR_MAGPIE_GATEWAY_KEY>" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "<PROVIDER/MODEL_WITHOUT_NATIVE_SEARCH>",
    "max_tokens": 512,
    "messages": [
      {
        "role": "user",
        "content": "Search Microsoft Web IQ REST API endpoints v3 and summarize the base URL in one sentence."
      }
    ],
    "tools": [
      {
        "type": "web_search_20250305",
        "name": "web_search",
        "max_uses": 2
      }
    ]
  }'
```

预期响应的 `content` 数组中会依次出现：
1. `server_tool_use`（`name: "web_search"`，包含模型生成的查询词）；
2. `web_search_tool_result`（包含由 Microsoft Web IQ 返回的网页结果列表）；
3. `text`（模型结合检索证据与来源链接生成的回答）。

---

## 7. Microsoft Web IQ 官方参考文档

- **门户与密钥管理**
  - [Key Management & API Access (Profiles)](https://webiq.microsoft.ai/profiles/)
  - [Interactive Playground](https://webiq.microsoft.ai/playground/)
  - [OpenAPI Specification (`openapi.json`)](https://webiq.microsoft.ai/documentation/openapi.json)
- **核心指南**
  - [Quick Start](https://webiq.microsoft.ai/documentation/quick-start/?view=md)
  - [Authentication (`x-apikey` & Entra ID OAuth 2.0)](https://learn.microsoft.com/en-us/web-iq/get-started/authentication)
  - [Passages and Content Formats](https://learn.microsoft.com/en-us/web-iq/concepts/content-formats)
  - [Error Handling & Retry Guidance](https://learn.microsoft.com/en-us/web-iq/reference/error-handling)
  - [Supported Languages and Regions](https://learn.microsoft.com/en-us/web-iq/reference/supported-languages-regions)
  - [MCP Server Integration (`https://api.microsoft.ai/v3/mcp`)](https://learn.microsoft.com/en-us/web-iq/integrations/mcp)
  - [SDKs and Libraries](https://learn.microsoft.com/en-us/web-iq/integrations/sdk)
  - [FAQ](https://learn.microsoft.com/en-us/web-iq/resources/faq)
- **REST API 端点参考**
  - [Web Search (`POST /v3/search/web`)](https://learn.microsoft.com/en-us/web-iq/reference/web-search)
  - [News Search (`POST /v3/search/news`)](https://learn.microsoft.com/en-us/web-iq/reference/news-search)
  - [Browse (`POST /v3/browse`)](https://learn.microsoft.com/en-us/web-iq/reference/browse)
  - [Videos Search (`POST /v3/search/videos`)](https://learn.microsoft.com/en-us/web-iq/reference/video-search)
  - [Images Search (`POST /v3/search/images`)](https://learn.microsoft.com/en-us/web-iq/reference/image-search)
  - [Places (`POST /v3/search/places`)](https://learn.microsoft.com/en-us/web-iq/reference/places)
  - [Auto (`POST /v3/auto`)](https://learn.microsoft.com/en-us/web-iq/reference/auto)
