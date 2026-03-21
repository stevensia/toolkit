---
name: cc-track
description: |
  Claude Code session orchestration via tmux. Use when user says "cc:" followed by
  natural language. Supports: starting/stopping CC sessions, sending tasks, checking
  status/logs, merging results, and multi-session parallel development. Trigger on any
  message prefixed with "cc:" or mentioning Claude Code sessions.
---

# CC Track — tmux × Claude Code 开发协作

## 触发规则

用户消息以 `cc:` 或 `cc ` 开头时激活本 skill。Agent 自行解析自然语言意图，映射到下方操作。

## 模式选择

| 场景 | 模式 | 说明 |
|------|------|------|
| 单一功能、明确范围 | **单轨** | 一个 tmux 会话 |
| 多功能并行、需要隔离 | **多轨** | 多个会话 + 文件分区 |
| 快速一次性 | **--print** | 无 tmux，直接输出 |
| 1-3 文件小改动 | **不用 CC** | Agent 自己 edit |

---

## 核心概念

### 会话命名

```
{project}-cc           # 单轨
{project}-cc-{track}   # 多轨: kv-cc-a, kv-cc-b
```

### 文件分区（多轨必须）

**每个 CC 会话只能操作分配给它的文件。** 在任务书中明确列出：
- `ALLOWED_FILES:` — 可以修改的文件列表
- `FORBIDDEN_FILES:` — 绝对不能碰的文件
- 共享文件（如主入口）**只由 agent 修改**，CC 不碰

### 项目记忆目录

```
{project}/.claude/
├── task-{track}.md           # 任务书（agent写，CC读）
├── progress-{track}.md       # 进度（CC写，agent读）
├── plan-YYYYMMDD.md          # 整体计划
└── review-YYYYMMDD.md        # Review 结果
```

---

## 操作手册

### 1. 启动会话

```bash
# 销毁旧的同名会话（如果存在）
tmux kill-session -t {name} 2>/dev/null

# 创建 tmux 会话
tmux new-session -d -s {name} -c {project_dir} -x 200 -y 50

# 启动 Claude Code
tmux send-keys -t {name} "claude" Enter
```

等待 **8-10 秒** 让 Claude Code 初始化。

### 2. Trust 确认（每次必须）

Claude Code 首次进入目录会弹出 trust 确认，**必须发送 Enter 确认**：

```bash
sleep 8
tmux send-keys -t {name} Enter
sleep 3
```

验证是否进入就绪状态（看到 `❯` 提示符）：
```bash
tmux capture-pane -t {name} -p | grep -v "^$" | tail -5
```

### 3. 发送任务

```bash
# 方法A: 引用任务文件（推荐，大任务）
tmux send-keys -t {name} -l -- "读取 .claude/task-{track}.md 并执行所有任务。完成每个子任务后更新 .claude/progress-{track}.md"
sleep 0.3
tmux send-keys -t {name} Enter

# 方法B: 直接发送（小任务）
tmux send-keys -t {name} -l -- "具体任务描述"
sleep 0.3
tmux send-keys -t {name} Enter
```

**重要**: 使用 `-l` (literal) 防止特殊字符被解析。

### 4. 检查状态

```bash
# 快速状态（最后20行，过滤空行）
tmux capture-pane -t {name} -p | grep -v "^$" | tail -20

# 检查是否在等待输入
tmux capture-pane -t {name} -p | tail -5 | grep -E "❯|Yes.*No|proceed|y/n|\?\s*$"

# 检查是否还在工作（有 spinner/timer）
tmux capture-pane -t {name} -p | tail -5 | grep -E "✢|✽|✻|Worked|Sautéed|Cogitated|tokens"

# 读取进度文件
cat {project_dir}/.claude/progress-{track}.md
```

### 5. 交互响应

```bash
# 确认
tmux send-keys -t {name} "y" Enter

# 拒绝
tmux send-keys -t {name} "n" Enter

# 发送自由文本
tmux send-keys -t {name} -l -- "补充说明..."
sleep 0.3
tmux send-keys -t {name} Enter
```

### 6. 停止/清理

```bash
# 优雅退出
tmux send-keys -t {name} "/exit" Enter

# 强制中断
tmux send-keys -t {name} C-c
sleep 1
tmux send-keys -t {name} C-c

# 销毁会话
tmux kill-session -t {name}
```

### 7. 一次性任务（无 tmux）

```bash
cd {project_dir} && claude --print --permission-mode bypassPermissions "任务描述" 2>&1
```

---

## 多轨并行流程

### 启动双轨

```
1. Agent 写任务书 → .claude/task-a.md, .claude/task-b.md
2. Agent 创建进度占位 → .claude/progress-a.md, .claude/progress-b.md
3. 创建 tmux 会话 → {project}-cc-a, {project}-cc-b
4. 各自启动 claude → trust确认 → 发送任务
5. Agent 按需检查 → capture-pane + progress文件
6. 完成后 → git diff 检查冲突 → agent合并 → 提交
```

### 合并检查

```bash
cd {project_dir} && git diff --stat

# 检查冲突（两个track改了同一文件 = 问题）
git diff --name-only | sort | uniq -d
```

---

## 会话保活与恢复

### 检测断连

```bash
tmux has-session -t {name} 2>/dev/null && echo "alive" || echo "dead"
tmux ls 2>&1
```

### 恢复流程

```bash
# 1. 检查 progress 文件确认完成了多少
cat {project_dir}/.claude/progress-{track}.md

# 2. 检查 git diff 看已经改了什么
cd {project_dir} && git diff --name-only

# 3. 创建新会话继续剩余任务
```

### 防止任务串扰

CC 完成后进入 idle 状态（显示 `❯`），如果发送给错误会话会执行错误任务。

**预防：**
- CC 完成后，立即发新任务或 `/exit` 退出
- 发任务前先 `capture-pane` 确认目标会话正确且处于 idle

---

## 错误处理

### CC 报错

```bash
# 检查错误
tmux capture-pane -t {name} -p | grep -i "error"

# 让 CC 自己修
tmux send-keys -t {name} -l -- "修复刚才的错误"
sleep 0.3
tmux send-keys -t {name} Enter
```

### CC 卡住（超过10分钟）

```bash
# 先看是不是在等确认
tmux capture-pane -t {name} -p | tail -10

# 中断重试
tmux send-keys -t {name} C-c
sleep 2
tmux send-keys -t {name} -l -- "继续执行剩余任务"
sleep 0.3
tmux send-keys -t {name} Enter
```

---

## 任务书模板

```markdown
# Task {Track} — {标题}

## 目标
简述要完成什么

## 允许修改的文件
- src/xxx.ts
- src/yyy.ts

## 禁止修改的文件
- src/app.ts
- src/shared/*

## 子任务
1. [ ] 第一步
2. [ ] 第二步
3. [ ] 第三步

## 约束
- 项目特定约束
- 代码规范要求

## 完成后
更新 .claude/progress-{track}.md
```

---

## 意图映射

用户说 `cc:` 后面的自然语言，agent 解析意图：

| 用户说 | Agent 做 |
|--------|----------|
| 启动 / start | 写任务书 + 创建tmux + 启动claude + trust确认 + 发任务 |
| 状态 / status | capture-pane 所有会话 + 读progress文件 + 汇总 |
| 日志 / logs | capture-pane \| tail -30 |
| 发 / send | tmux send-keys 到对应会话 |
| 停 / stop | /exit 或 C-c + kill-session |
| 合并 / merge | git diff --stat + 检查冲突 + 汇总改动 |
| 确认 / yes | send-keys "y" Enter |
| 恢复 / resume | 检查progress + 恢复断开的会话 |
| 下一步 / next | 汇总完成项 + 规划下轮任务 |
| 自动模式 | 启用连续调度（CC完成后自动下一轮，不等确认） |

**注意：** 默认不自动连续调度，需用户说 `cc: 自动模式` 或 `cc: 连续跑` 才启用。

---

## ⚠️ 硬性规则

1. **不在 `~/.openclaw/` 下启动 Claude Code**
2. **Build 和 Deploy 必须用户确认**
3. **文件分区必须严格执行** — CC 修改了禁止文件要立即停止并回滚
4. **进度文件由 CC 自己更新** — Agent 只读（创建占位除外）
5. **tmux send-keys 必须用 `-l`** — 防止特殊字符问题
6. **不要 `rm`，用 `git checkout` 回滚**
7. **不要重启 Gateway 或 OpenClaw**
8. **trust 确认不能跳过** — 每次新会话必须等待并按 Enter
9. **CC idle 后及时处理** — 要么发新任务，要么 `/exit`，避免串扰
10. **默认不自动连续调度** — 除非用户明确启用
