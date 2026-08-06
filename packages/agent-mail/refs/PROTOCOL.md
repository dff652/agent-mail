# Agent Mail Protocol（给 Agent 与人读）

**产品名**：**Agent Mail**（Agent 邮箱）\
**版本**：0.2
**决策**：D-023 数据模型 · D-024 M1 范围
**Schema**：[message.schema.json](./message.schema.json)

---

## 0. 你是谁、在干什么

你是接入 **Agent Mail** 的 coding agent（或人通过 CLI）。\
本系统是 **异步邮箱 + 任务总线**，不是实时 IM。

- 数据在项目目录 **`.agent-mail/`**（默认）。
- 工具：MCP（优先）或 CLI **`agent-mail`**（同语义）。
- **M1 兜底 = CLI**，不依赖纯文件 inbox 目录（D-024）。
- **禁止**让人在窗口间复制粘贴大段上下文。

---

## 1. Agent ID

格式：`{name}@{scope}`，例如 `claude-code@local`、`codex@local`、`grok@local`、`human@local`。

- `to` **必须是** roster 中的 agent id。
- **M1 不支持** `channel:*`（D-024）。多收件人 = 分别 `send` 多条。

---

## 2. 四层语义（D-023，必读）

| 层 | 是什么 | 不是什么 |
|----|--------|----------|
| **message** | 不可变消息内容 | 不含「已读/已领」 |
| **delivery** | 对该收件人的投递与 claim/lease | 不是任务是否做完 |
| **task** | 工作项生命周期 | 不是邮箱游标 |
| **approval** | 人对副作用的批准 | **不是** delivery ack |

命名：**ack** = 确认投递/处理完毕（delivery）；**approve** = 人批准执行（approval）。

---

## 3. 消息类型 `type`

| type | 含义 |
|------|------|
| `message` | 一般说明 |
| `task` | 请对方工作 → 创建 **task** + **delivery** |
| `done` | 任务完成汇报（新消息；关闭 task=completed） |
| `error` | 任务失败汇报（task=failed） |
| `question` | 问 peer |
| `escalate` | 必须人处理 → 通常 `to=human@local` |
| `status` | 进度 |
| `cancel` | 取消 task |

---

## 4. 状态机

### 4.1 delivery

```text
pending → claimed → acked
              ↘（lease 过期）→ pending（可再 claim）
```

同一 lease 有效期间，重复 `claim` 也返回冲突；M1 不把重复调用当作续租。

对原始 `type=task` delivery，只有关联 task 已进入 `completed` / `failed` / `cancelled` 后才能 `ack`。提前 ack 会返回 `task is not terminal; send done/error before ack`，delivery 保持 `claimed`。

升级前若已形成 `acked + in_progress` 的历史 task，原 claim owner 仍可补发 `done/error` 完成恢复；新版本不会再生成这种状态。

### 4.2 task

```text
open → in_progress → completed | failed | cancelled
```

### 4.3 approval（副作用）

```text
pending → approved | rejected
```

`effect_level` 为 `write`/`dangerous` 或 `requires_human_approval=true` 时，**执行前**须有 approved（默认策略 approve-writes）。

- `send task` 与 `inbox` 会暴露关联 `approval_id`；也可用 `approvals` 查询。
- 只有 `human@local` 可以 `approve` / `reject`。
- `done` 会检查 approval；pending/rejected 的任务不能进入 completed。

---

## 5. 任务闭环（标准剧本）

1. A：`send type=task` → B（创建 message + delivery(B) + task=open）
2. B：`inbox` → `claim`（delivery=claimed，task=in_progress）
3. B：若需写代码且策略要求 → 等人 `approve`（或会话内人已授权并记录）
4. B：工作完成后先 `send type=done/error`（同 thread，带 task_id），成功后再 `ack` 原 delivery
5. A：`inbox` 收到 done → **对人可见化摘要**

---

## 6. Agent MUST

1. 回合开始/结束检查 **inbox**。
2. 对 task：**claim → 工作 → done/error + ack**。
3. 处理 task/done/error/escalate/写操作时，**在对用户回复中摘要**。
4. 遵守 effect_level 与各工具自身 permission。
5. 大段结论用 `doc_refs` 指向仓库路径，勿把整仓贴进 body。

---

## 7. 工具 / CLI 映射

| 意图 | CLI |
|------|-----|
| 初始化 | `agent-mail init` |
| 发送 | `agent-mail send --as ID --to ID --type task --body "..."` |
| 收件箱 | `agent-mail inbox --as ID` |
| 领取 | `agent-mail claim MSG_ID --as ID` |
| 投递确认 | `agent-mail ack MSG_ID --as ID` |
| 人批准 | `agent-mail approve APPROVAL_ID --as human@local` |
| 人拒绝 | `agent-mail reject APPROVAL_ID --as human@local` |
| 审批列表 | `agent-mail approvals` |
| 列表 | `agent-mail agents` / `agent-mail tail` |
| 健康检查 | `agent-mail doctor` |
| 诊断快照 | `agent-mail diagnose [--json]` |
| 生命周期事件 | `agent-mail events [--task-id ID] [--thread ID]` |
| MCP/CLI 运行日志 | `agent-mail logs [--outcome error]` |
| CLI traceback | `agent-mail --debug COMMAND ...` |

---

## 8. 目录（`.agent-mail/`）

```text
.agent-mail/
  config.json
  agents.json
  policy.yaml
  store.sqlite
  PROTOCOL.md
  docs/
  export/
  logs/
    runtime.jsonl
```

**无** 正式 `inbox/<agent>/` 文件协议（M1）。弱端用 **CLI**。

`events` 不含消息正文和审批 note；runtime log 对正文与常见凭据字段做脱敏。排障见 `docs/guides/observability-debugging.md`。

---

## 9. 错误

| 情况 | 行为 |
|------|------|
| to 不在 roster / 非法 id | 拒绝 |
| channel: | 拒绝（M1） |
| claim 冲突 | 错误，已有领取者 |
| lease 过期后原 owner ack | 拒绝 |
| done/error 的 sender、thread、claim 与 task 不匹配 | 拒绝 |
| write task 未批准即 done | 拒绝 |

---

## 10. 版本

| 版本 | 说明 |
|------|------|
| 0.2 | D-023/D-024；与 M1 实现对齐 |
