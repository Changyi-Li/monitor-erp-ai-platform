## Agent skills

### Testing

默认轻量分层（单元 → 受影响 e2e → 提交前才全量）；e2e 已配置提速（isolate 共享 import + 测试环境低 bcrypt 轮数）。见 `docs/agents/testing.md`。

### Issue tracker

Issues live in GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
