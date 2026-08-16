# 原生 Multi-Agent 通信契约

本契约约束主 Agent、原生 Codex subagent 和 Web-LLM 推理层之间的任务包与回执。内部编排使用平台原生 subagent 工具；`codex_app__create_thread` 只用于用户明确要求创建独立 App 任务的场景，不是本契约的 transport。

## 任务包

每个子任务至少包含：

```text
route_id: 稳定路由 ID
attempt: 单调递增
execution_mode: serial | parallel
branch_id: 串行为 none；并行分支使用稳定 ID
contract: scout | reasoner | verifier
owner: 唯一责任角色
scope: 目标、路径、系统和时间边界
inputs_by_reference: 字面路径、前序 output_ref 或必要消息引用
owned_paths: read-only | 明确且不重叠的写入路径 | none
one_required_output: 唯一必需产物或结论
acceptance_criteria: 可证伪的逐项条件
constraints: 外部传输、提交、推送、删除、发布与审批边界
```

需要 Web-LLM 时再包含 `modality`、`provider_policy`、`fallback_policy` 和 `approval_source`。不要复制与任务无关的源码、日志、DOM、OCR、Cookie、令牌或私密数据。

## 有界回执

```text
route_id
attempt
branch_id
contract
owner
status: completed | needs_more_context | needs_user_approval | failed | blocked
model / model_source
request_id / provider
output_ref
changed_files / diff_stat
tests_run / test_result
evidence_refs
unresolved
summary
```

`scout` 必须返回 `findings`；`reasoner` 必须返回 `conclusion` 与 `assumptions`；`verifier` 必须返回 `checks` 与 `result`。回执保持短小，不粘贴完整源码、完整 diff、长日志、页面正文、DOM、OCR 或密钥。

## 生命周期

1. 主 Agent 选择 contract、唯一 owner 与串并行方式。
2. 通过原生 subagent 工具发送任务包。
3. 最多 3 个真正独立的分支并行；写入范围不能重叠。
4. 主 Agent 等待回执，同时可继续不冲突的本地工作。
5. 回执只缺一个具体字段时，向原 subagent 最多续问一次。
6. 主 Agent 定点读取证据、复跑必要检查并做最终决策。
7. 完成后关闭或结束对应 subagent。

原生 subagent 工具不可用时，主 Agent 直接执行，不创建独立 App task，也不要求用户提供线程 ID。失败只在实际缺少权限、输入、登录、审批或外部状态时才升级为用户阻塞。

## Web-LLM

达到 token gate 时，`reasoner` 可在其任务内或由主 Agent 调用 `agentchat-code-offload`。Provider 是推理来源，不是 Codex subagent transport；成功回执必须包含 `model_source=web_provider`、具名 provider 和 `request_id`。

Provider 链串行；全部合格文本 Provider 失败后最多一次 `deepseek-v4-pro-deepseek` 回退。Web-LLM 不修改文件、不运行命令、不执行 Git 或外部领域动作。主 Agent 必须本地核验后才可实施。

## 审批

子任务分发不会扩大用户授权。具名 Provider 的敏感数据传输、发布、发送、删除、付款、账户和生产动作必须分别满足现有用户授权与领域 Skill。
