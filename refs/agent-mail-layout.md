# `.agent-mail/` 目录布局

**版本**：0.1
**关联**：[PROTOCOL.md](./PROTOCOL.md) · [README](../README.md)

```text
.agent-mail/
├── config.json          # 项目级配置
├── agents.json          # roster（见 roster.schema.json）
├── policy.yaml          # 执行策略与可选 allowlist
├── store.sqlite         # 消息 / 线程 / 游标 / lease
├── PROTOCOL.md          # 协议副本（给 agent 读）
├── message.schema.json  # message envelope JSON Schema
├── roster.schema.json   # roster JSON Schema
├── docs/                # 可选：共享协作文档
└── export/              # 可选：JSONL 导出
```

## config.json 示例

`policy.yaml` 是执行模式与 allowlist 的权威配置；`config.json` 中同名字段为 0.1 兼容元数据，当前运行时策略以 `policy.yaml` 为准。

```json
{
  "schema_version": "0.1",
  "default_execution_mode": "approve-writes",
  "roster_mode": "open",
  "lease_seconds": 3600,
  "remote_enabled": false
}
```

## policy.yaml 示例

```yaml
# default_execution_mode: autonomous | approve-writes | view-only
default_execution_mode: approve-writes

# roster_mode: open | allowlist
roster_mode: open

# 仅 roster_mode=allowlist 时生效
# allow_edges:
#   - from: claude-code@local
#     to: codex@local
#     types: [task, message, question]
#   - from: codex@local
#     to: claude-code@local
#     types: [done, error, message, question]

effect_rules:
  write: requires_human_approval
  dangerous: requires_human_approval
```

## agents.json 示例（init 默认）

```json
{
  "version": 1,
  "agents": [
    {
      "id": "claude-code@local",
      "display_name": "Claude Code",
      "skills": ["implement", "refactor"]
    },
    {
      "id": "codex@local",
      "display_name": "Codex",
      "skills": ["review", "long-task"]
    },
    {
      "id": "grok@local",
      "display_name": "Grok",
      "skills": ["review", "research"]
    },
    {
      "id": "human@local",
      "display_name": "Human",
      "skills": ["decide", "escalate"]
    }
  ]
}
```

## Git

建议 **忽略** 运行时库与导出：

```gitignore
.agent-mail/store.sqlite
.agent-mail/store.sqlite-*
.agent-mail/export/
```

可选择提交 `PROTOCOL.md`、`policy.yaml`、`agents.json` 模板以便团队共享约定（init 会生成）。
