# GitHub Copilot Proxy 完整部署指南

> 将 GitHub Copilot API 反向代理为 OpenAI/Anthropic 兼容接口，可供 Claude Code、Codex 等工具使用。

## 当前主机配置概览

| 项目 | 值 |
|------|-----|
| 包名 | `@jer-y/copilot-proxy` |
| 版本 | `0.3.1` |
| 项目地址 | https://github.com/jer-y/copilot-proxy |
| Node.js 版本 | `v22.22.1` (NodeSource APT 仓库安装) |
| 监听端口 | `4399` |
| 账户类型 | `individual` |
| 运行用户 | `azuser` |
| Systemd 服务 | `/etc/systemd/system/copilot-proxy.service` (enabled) |
| 认证数据 | `~/.local/share/copilot-proxy/github_token` |
| 守护进程配置 | `~/.local/share/copilot-proxy/daemon.json` |

---

## 在新 Linux 主机上部署

### 第 1 步：安装 Node.js (>= v22)

#### 首选方式：NodeSource APT 仓库 (当前主机使用，生产验证，推荐)

> 当前主机正在使用此方式，已稳定运行。Node.js 安装到 `/usr/bin/node`，npm 全局包安装到 `/usr/lib/node_modules/`，命令链接到 `/usr/bin/`。路径固定、systemd 友好，是服务器部署的最佳选择。

```bash
# 1. 添加 NodeSource 22.x APT 仓库
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -

# 2. 安装 nodejs（自带 npm）
sudo apt-get install -y nodejs

# 3. 验证安装
node --version   # 预期输出: v22.22.1 或更高
npm --version

# 4. 确认安装路径（后续 systemd 服务文件依赖这些路径）
which node           # 预期: /usr/bin/node
which npm            # 预期: /usr/bin/npm
```

**为什么推荐 NodeSource：**
- `/usr/bin/node` 路径固定，systemd `ExecStart` 无需调整
- `npm -g` 安装的包链接到 `/usr/bin/`，全局可用
- `apt upgrade` 即可升级，融入系统包管理
- 不依赖用户 home 目录，适合多用户/服务场景

#### 备选方式：nvm（开发环境适用，不推荐用于 systemd 服务）

> nvm 将 Node.js 装在用户 home 下（如 `~/.nvm/versions/node/v22.x.x/bin/node`），路径随版本变化，systemd 中需要写死绝对路径，切换版本后服务会断。仅建议开发测试用。

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
node --version

# 如果用 nvm，后续 systemd ExecStart 必须写完整路径，例如：
# ExecStart=/home/azuser/.nvm/versions/node/v22.22.1/bin/node /home/azuser/.nvm/versions/node/v22.22.1/bin/copilot-proxy start ...
```

### 第 2 步：全局安装 copilot-proxy

```bash
sudo npm install -g @jer-y/copilot-proxy@0.3.1
```

安装完成后验证：

```bash
# 确认命令可用
which copilot-proxy
# 预期输出: /usr/bin/copilot-proxy 或 /usr/local/bin/copilot-proxy

# 确认符号链接
ls -la $(which copilot-proxy)
# 预期输出: ... -> ../lib/node_modules/@jer-y/copilot-proxy/dist/main.js
```

### 第 3 步：创建运行用户 (可选，推荐不用 root 运行)

```bash
# 如果你希望使用专用用户运行（和源主机一样用 azuser）
sudo useradd -m -s /bin/bash azuser

# 如果你希望直接用 root 运行，跳过此步，后续步骤中将 azuser 替换为 root
```

### 第 4 步：GitHub 认证（首次必须交互完成）

> **重要：** 首次运行需要进行 GitHub OAuth 设备授权，会要求你在浏览器中确认。确保你的 GitHub 账户已订阅 Copilot。

```bash
# 切换到运行用户
sudo -i -u azuser

# 方式一：直接启动，会自动触发认证流程
copilot-proxy start --port 4399 --account-type individual

# 方式二：仅认证，不启动服务
copilot-proxy auth
```

认证过程：
1. 终端会显示一个 **设备验证码** (如 `XXXX-XXXX`) 和一个 URL
2. 在浏览器打开 https://github.com/login/device
3. 输入显示的验证码并授权
4. 终端会提示认证成功

认证成功后，token 会保存在：

```
~/.local/share/copilot-proxy/github_token
```

**或者**，如果你已经有 GitHub token，可以直接传入：

```bash
# 从源主机获取 token（在源主机执行）
cat /home/azuser/.local/share/copilot-proxy/github_token

# 在新主机上使用 token 启动
copilot-proxy start --github-token <your_token> --port 4399 --account-type individual
```

验证认证后按 `Ctrl+C` 停止前台进程。

### 第 5 步：创建 Systemd 服务

```bash
sudo tee /etc/systemd/system/copilot-proxy.service > /dev/null << 'EOF'
[Unit]
Description=GitHub Copilot Proxy
After=network.target

[Service]
Type=simple
User=azuser
ExecStart=/usr/bin/node /usr/bin/copilot-proxy start --_supervisor --port 4399 --account-type individual
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

> **注意：** 如果你的 `node` 或 `copilot-proxy` 安装路径不同，请使用以下命令查找并替换：
> ```bash
> which node           # 可能是 /usr/local/bin/node
> which copilot-proxy  # 可能是 /usr/local/bin/copilot-proxy
> ```
> 将 `ExecStart` 中的路径替换为实际路径。

### 第 6 步：启用并启动服务

```bash
# 重新加载 systemd 配置
sudo systemctl daemon-reload

# 设置开机自启
sudo systemctl enable copilot-proxy.service

# 启动服务
sudo systemctl start copilot-proxy.service

# 查看状态
sudo systemctl status copilot-proxy.service
```

### 第 7 步：验证服务

```bash
# 检查端口监听
ss -tlnp | grep 4399

# 测试 API 可用性 — 获取模型列表
curl http://localhost:4399/v1/models

# 测试 OpenAI 兼容接口
curl http://localhost:4399/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 50
  }'

# 测试 Anthropic 兼容接口
curl http://localhost:4399/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: anything" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 50
  }'
```

---

## 与 Claude Code 配合使用

将 copilot-proxy 作为 Claude Code 的后端：

```bash
# 方式一：copilot-proxy 自带的 claude-code 启动集成
copilot-proxy start --claude-code --port 4399 --account-type individual

# 方式二：手动配置环境变量后启动 Claude Code
export ANTHROPIC_BASE_URL=http://localhost:4399
export ANTHROPIC_API_KEY=anything
claude
```

---

## 常用运维命令

```bash
# 查看服务状态
sudo systemctl status copilot-proxy

# 查看实时日志
sudo journalctl -u copilot-proxy -f

# 重启服务
sudo systemctl restart copilot-proxy

# 停止服务
sudo systemctl stop copilot-proxy

# 禁用开机自启
sudo systemctl disable copilot-proxy

# 查看 copilot-proxy 自身的 daemon 日志（如果曾使用 -d 模式启动过）
cat ~/.local/share/copilot-proxy/daemon.log
```

---

## 命令行参数参考

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--port`, `-p` | 监听端口 | `4399` |
| `--account-type`, `-a` | 账户类型 (`individual`, `business`, `enterprise`) | `individual` |
| `--verbose`, `-v` | 详细日志 | `false` |
| `--github-token`, `-g` | 直接传入 GitHub token | 无 |
| `--rate-limit`, `-r` | 请求间隔限制 (秒) | 无 |
| `--wait`, `-w` | 达到速率限制时等待而非报错 | `false` |
| `--manual` | 手动审批每个请求 | `false` |
| `--show-token` | 显示 token 信息（调试用） | `false` |
| `--claude-code`, `-c` | 生成 Claude Code 启动命令 | `false` |
| `--daemon`, `-d` | 后台守护进程模式运行 | `false` |
| `--proxy-env` | 从环境变量初始化代理 | `false` |
| `--_supervisor` | 内部 supervisor 模式（systemd 使用） | — |

---

## 关键文件路径

| 文件 | 路径 | 说明 |
|------|------|------|
| Node.js | `/usr/bin/node` | Node.js 运行时 |
| copilot-proxy CLI | `/usr/bin/copilot-proxy` | 符号链接到 npm 全局包 |
| npm 全局包 | `/usr/lib/node_modules/@jer-y/copilot-proxy/` | 包安装目录 |
| Systemd 服务 | `/etc/systemd/system/copilot-proxy.service` | 系统服务配置 |
| GitHub Token | `~/.local/share/copilot-proxy/github_token` | 认证令牌 (运行用户目录下) |
| 守护进程配置 | `~/.local/share/copilot-proxy/daemon.json` | 守护进程运行配置 |
| 守护进程日志 | `~/.local/share/copilot-proxy/daemon.log` | 守护进程日志文件 |
| 守护进程 PID | `~/.local/share/copilot-proxy/daemon.pid` | 守护进程 PID 文件 |

---

## 故障排查

### 服务无法启动
```bash
# 查看详细错误
sudo journalctl -u copilot-proxy -n 50 --no-pager

# 手动前台运行测试
sudo -u azuser /usr/bin/node /usr/bin/copilot-proxy start --verbose --port 4399 --account-type individual
```

### Token 过期
```bash
# 重新认证
sudo -i -u azuser
copilot-proxy auth
exit
sudo systemctl restart copilot-proxy
```

### 端口被占用
```bash
# 查看谁占用了端口
ss -tlnp | grep 4399

# 杀掉占用进程或更换端口
sudo systemctl stop copilot-proxy
# 修改 service 文件中的 --port 参数
sudo systemctl daemon-reload
sudo systemctl start copilot-proxy
```

---

## 安全提醒

> ⚠️ 此工具基于 GitHub Copilot API 的逆向工程，**不受 GitHub 官方支持**，可能随时失效。
> 过度或自动化的大量请求可能触发 GitHub 的滥用检测系统，导致 Copilot 访问被暂停。
> 请合理使用，遵守 [GitHub 可接受使用政策](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies) 和 [GitHub Copilot 条款](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)。
