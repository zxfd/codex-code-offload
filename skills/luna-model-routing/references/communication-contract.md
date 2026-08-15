# 模型路由通信契约

本契约规定协调 Agent、独立 `Worker` Thread 和 Web-LLM Thread 的任务包、唯一传输、生命周期、回执与审批边界。凡未在本契约中明确的做法均不得作为隐含兜底。

## 目录

- [Thread 绑定与传输](#thread-绑定与传输)
- [任务包字段](#任务包字段)
- [职责映射](#职责映射)
- [固定生命周期](#固定生命周期)
- [有界回执](#有界回执)
- [Web-LLM 与 URL 摄取](#web-llm-与-url-摄取)
- [审批与拒绝](#审批与拒绝)

## Thread 绑定与传输

`Worker` 只表示一个逻辑职责，不表示执行载体。每个 `Worker` 必须一对一绑定一个由 `codex_app__create_thread` 创建的后台 `Codex App Thread`；一个 Thread 不得承载多个互相独立的 Worker 职责，一个 Worker 也不得跨 Thread 执行。任务包中的 `model` 字段记录当前模型，不能由 Worker 名称推断。

内部所有 `work_class` 的 `transport` 必须是 `codex_thread`，不得出现其他传输值。`web_provider` 只允许出现在 `model_source`，表示 Thread 内 Browser Adapter 使用的 Provider；它不是 `transport`，也不是独立 Worker 载体。

明确禁止 `subagent`、`spawn_agent`、等价 `Worker`、本地直做、协调窗口执行和任何非 Thread 兜底。协调 Agent 不能把自己临时改名为 Worker，也不能用普通命令、脚本、模型调用或 Provider 代替 Thread。

## 任务包字段

每次分发都必须发送结构化任务包，不得只发送口头说明或整段用户原文。字段如下：

```text
route_id: 稳定 ID；续问和回退保持不变
attempt: 单调递增的尝试次数
execution_mode: serial | parallel
branch_id: 并行分支的稳定 ID；串行为 none
work_class: 一个职责类别
owner: 对 one_required_output 唯一负责的逻辑职责名
transport: codex_thread
model: 当前 Thread 使用的模型 ID
model_source: codex_internal | web_provider
thinking: 当前 Thread 的推理强度
scope: 允许处理的目标、路径、URL、系统和时间边界
caller_project_id: 发起调用所在本地项目的精确 projectId；跨项目调用必须由调用方传入
caller_project_path: 发起调用所在本地项目的绝对路径引用；不得使用协调窗口项目路径替代
inputs_by_reference: Worker 自行读取的字面路径、URL、消息引用或前序 output_ref
owned_paths: read-only | 明确可写路径列表 | none
approval_source: none | user_message_ref | domain_skill_managed | named_provider_approval_ref
one_required_output: 唯一必需工件或有界结论
acceptance_criteria: 可由回执或验收 Worker 证明的逐项条件
coordinator_forbidden: 协调 Agent 明确不得读取、运行或接管的事项
constraints: Thread、外部传输、提交、推送、删除、发布和其他边界
```

适用时还必须写明 `allowed_instruction_reads`、`context_policy: source_once`、`do_not_rescan`、`depends_on`、`fallback_policy`、`modality` 和 `risk`。`coordinator_forbidden` 不得为空，至少声明协调 Agent 不得读取 `inputs_by_reference` 正文、执行该 `work_class`、复跑验收命令或在失败时接管。

`inputs_by_reference` 只传引用，不得把源码片段、完整日志、文档正文、差异、DOM、OCR、截图、Cookie、令牌或私密记录复制到协调上下文。Worker 需要额外输入时，只返回 `needs_more_context` 和最小引用请求。

## 职责映射

下表是唯一职责映射；表中每一行的 `transport` 都必须是 `codex_thread`。

| `work_class` | `owner` | `transport` | Thread 内的职责 | 协调 Agent 禁止事项 |
|---|---|---|---|---|
| `routing_consultation` | `routing_advisor` | `codex_thread` | 在独立 Thread 内通过 Browser Adapter 和 Web-LLM Provider 建议类别、职责、拆分与验收字段 | 不得自行判断未知路线，不得把咨询当执行或审批 |
| `repository_read_analysis` | `repository_analysis_worker` | `codex_thread` | 读取、搜索、追踪仓库并返回有界结论或 `edit_spec` | 不得枚举、读取或重复分析仓库证据 |
| `repository_write` | `repository_write_worker` | `codex_thread` | 在授权路径内读取必要上下文并创建、修改、移动或删除文件 | 不得读源码、写文件或应用替代性本地改动 |
| `command_execution` | `execution_worker` | `codex_thread` | 运行命令、脚本、构建、测试、格式化、哈希和运行时检查 | 不得运行命令或读取原始输出 |
| `git_operation` | `git_worker` | `codex_thread` | 按授权检查 Git、审查差异、暂存、提交或推送 | 不得运行 Git 或改变提交状态 |
| `skill_lifecycle_validation` | `skill_validation_worker` | `codex_thread` | 运行官方校验、安装一致性检查和实际安装路径健康检查 | 不得查安装根、运行校验或混淆源码态与安装态 |
| `browser_local_operation` | `browser_worker` | `codex_thread` | 在独立 Thread 内操作浏览器、执行 `url_preingest` 和返回有界结果 | 不得打开浏览器、读取页面证据或调用摄取函数 |
| `web_llm_reasoning` | `web_llm_provider` | `codex_thread` | 在独立 Thread 内运行 Browser Adapter，并返回 `model_source=web_provider` 的 Provider 回执 | 不得调用 Adapter、读取打包内容或冒充 Provider |
| `verification` | `verification_worker` | `codex_thread` | 独立读取工件或证据并逐项验证验收条件 | 不得亲自读取工件、复跑命令或重新实施 |
| `domain_external_action` | `domain_action_worker` | `codex_thread` | 依照领域 Skill 执行发送、发布、删除、付款、账户或生产动作 | 不得执行动作或扩大领域审批 |

一个 Thread 只有在同一任务包明确授予全部范围和权限、各职责不跨越审批边界，并且仍能返回逐项回执时，才能顺序承担多个 `work_class`。这不会改变一 Worker 一 Thread 的绑定，也不能把职责退回协调窗口。

## 固定生命周期

### 项目型本地创建约束

仓库 Worker Thread 的唯一归属是发起调用所在的本地项目，而不是协调窗口、父任务或当前聊天窗口所在的项目。每个仓库任务包必须包含 `caller_project_id` 与 `caller_project_path`；其他项目调用本 Skill 时，调用方必须把这两个字段连同任务包传递。协调 Agent 不得自行填充、猜测、改写或回退到自己的项目。

协调 Agent 必须先调用 `codex_app__list_projects`，按规范化绝对路径精确匹配 `caller_project_path`，并确认返回记录的 `projectId` 精确等于 `caller_project_id`，才可创建 Thread。项目 ID 缺失、路径缺失、无法解析、无精确匹配、返回项目类型不符或调用方项目与待创建 Thread 项目不一致时，必须 `fail-closed`，不得创建、运行或验收该 Thread。创建参数必须满足：

```text
target.type = project
target.projectId = <与 caller_project_path 精确匹配的 caller_project_id>
target.environment.type = local
```

明确禁止 `target.type=projectless`、`target.type=chatgptWorkCloud`、聊天目标以及任何无项目目标。初始 prompt 必须包含 `TASK_KIND: work_task`，并将目标描述为可验收的工作任务；不得把新 Thread 创建成聊天。Git 项目仍按调用方项目的 `list_projects.isGitRepository` 选择 `worktree`（默认）或 `local`，但不能离开调用方项目的本地环境。

创建返回后，在第 4 步等待前必须确认真实且可解析的非空 `threadId` 与 `hostId`，并核对 Thread 的项目 ID、规范化路径、目标类型和环境分别为 `caller_project_id`、`caller_project_path`、`project`、`local`。Git 项目的目标嵌套结构必须是 `target.environment.workspace.type=worktree`；非 Git 项目必须是 `target.environment.workspace.type=local`。只有 `clientThreadId`、空值或无法读取的 Thread 身份不能作为成功凭证；任何归属字段不一致都必须 `fail-closed`，不得继续工作或把结果转交协调窗口。

仓库任务严格执行以下顺序：

1. `codex_app__list_projects`
2. `codex_app__create_thread(model, thinking, project, task packet)`
3. 确认真实 `threadId` 与 `hostId`
4. `codex_app__wait_threads`
5. `codex_app__read_thread`
6. 回执只缺一个具体字段时，向原 Thread 最多一次 `codex_app__send_message_to_thread`
7. 主 Agent 验收
8. `codex_app__set_thread_archived(threadId, hostId, archived=true)`，并验证返回状态为已归档

只有 `create_thread` 返回的非空、真实且能被 Thread 工具解析的 ready `threadId` 和 `hostId` 才算成功创建。`clientThreadId` 只能表示准备中的 setup handle；不得传给 `wait`、`read`、`send` 或 `archive`，不能作为成功凭证、不能开始验收，也不能交由协调 Agent 接管。若未来提供专用精确 resolver，只能使用其明确返回的唯一 ready `threadId`+`hostId`；resolver 不存在、超时、缺字段、多候选或项目身份冲突均返回 `blocked`。不得用标题、时间、项目名、cwd 或 `list_threads` 顺序猜测或解析 Thread。

项目身份校验必须同时精确匹配 `caller_project_id` 与规范化绝对 `caller_project_path`；cwd 不是稳定身份。禁止 projectless、聊天、云端目标，以及任何未通过 `target.type=project`、匹配 `projectId`、`environment.type=local` 和 Git/non-Git workspace 类型校验的 Thread。

等待期间协调 Agent 不执行已分发任务。续问只能补齐一个具体缺失字段，不得重发完整任务包；若仍失败，按 `fallback_policy` 或 `blocked` 结束。同一路由的续问和回退保持 `route_id`，并递增 `attempt`。

## 有界回执

每个 Thread 只返回与 `acceptance_criteria` 直接相关的短回执：

```text
route_id
attempt
execution_mode
branch_id
work_class
owner
transport
model
model_source
thinking
status: planned | running | needs_more_context | needs_user_approval | completed | failed | accepted | rejected | blocked
threadId / hostId
clientThreadId: 仅准备中时可出现
request_id / provider
output_ref
artifact_fingerprints
changed_files
diff_stat
commands_run
tests_run / test_result
validation_summary
approval_state
fallback_reason
unresolved
summary
```

不得粘贴完整源码、完整差异、长日志、文档正文、页面正文、DOM、OCR、截图、令牌或私密数据。需要交付大工件时只返回稳定 `output_ref` 与指纹。写入回执必须包含 `changed_files`、`diff_stat`、`tests_run`、`test_result`、`unresolved` 和一句摘要；分析回执还应包含以下 `edit_spec`：

```text
path
symbol_or_anchor
anchor_fingerprint
required_transformation
cross_file_effects
targeted_tests
unresolved
```

协调 Agent 只核对字段、状态、摘要和验收覆盖，不读取 `output_ref` 正文、不复跑命令、不读取源码或差异。需要独立事实时，创建另一个具备一对一 Thread 绑定的 `verification` 任务。

## Web-LLM 与 URL 摄取

未知路由必须创建 `routing_consultation` Codex App Thread；该 Thread 内的 Web-LLM Provider 只返回 `work_class`、`owner`、`transport`、拆分顺序和验收字段建议，不执行任务、不授权后续工作、不批准外部传输、不批准领域动作。

Web-LLM 任务必须由独立 Codex App Thread 承载 Browser Adapter，并在回执写 `model_source=web_provider`；Provider 链在同一 Thread 内串行。所有符合条件的文本 Provider 都失败后，才允许一次 `v4_fallback_thread`，模型为 `deepseek-v4-pro-deepseek`，传输仍为 `codex_thread`；失败即 `blocked`，不得由协调 Agent 接管。视觉 Provider 全部失败时直接 `blocked`，纯文本模型不得声称看过像素。

对明确批准的单个 URL，`browser_worker` 先从实际安装根运行 `scripts/health-check.mjs`，失败即 `fail-closed`。随后用 `ingestSingleUrlWithLocalContext` 和 `allowExternalTransfer: false` 完成本地预摄取，返回 `status: requires_user_approval` 后，针对具体页面数据和一个具名 Provider 请求批准。批准后同一路由只允许该具名 Provider 一次调用，并设置 `allowExternalTransfer: true`；失败时必须重新请求具名 Provider 审批，不得沿用旧审批调用其他 Provider。

## 审批与拒绝

`approval_source` 只记录应核验的权威来源，不是可转移令牌。路由、咨询、分析、读取、写入、测试、Git 或 Skill 校验都不自动授权外部动作。更换 Worker、Thread、Provider、路由或动作范围时不得沿用旧审批。

任何无法取得真实 `threadId`、`hostId`、有界回执或必需验收字段的情况，都必须停止并返回 `blocked`、`needs_more_context` 或一次允许的续问；不得通过 `subagent`、`spawn_agent`、等价 `Worker`、本地直做、协调窗口执行或非 Thread 回退继续。
