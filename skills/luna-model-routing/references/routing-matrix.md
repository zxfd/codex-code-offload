# 模型路由矩阵

本矩阵先按任务内容选择 `work_class`，再选择唯一 `owner`。所有任务工作都必须由独立 `Codex App Thread` 承载，所有内部 `transport` 都是 `codex_thread`；协调 Agent 没有任务执行路由。

## 选择矩阵

| 条件 | `work_class` | `owner` | `transport` | 约束 |
|---|---|---|---|---|
| 读取生效 `AGENTS.md`、已触发 `SKILL.md` 或其明确选定引用 | 控制面读取 | 协调 Agent | 控制规则 | 只允许控制内容，不读取任务证据 |
| 拆解、建 Thread、发送、等待、一次续问、验收、归档和交付 | 控制面协调 | 协调 Agent | `codex_thread` | 只操作 Thread 控制工具，不执行任务 |
| 无法确定职责、负责人、传输或拆分方式 | `routing_consultation` | `routing_advisor` | `codex_thread` | 在 Thread 内通过 Web-LLM 提供建议，不执行任务 |
| 读取、搜索、追踪或总结仓库源码、配置、日志、报告或文档 | `repository_read_analysis` | `repository_analysis_worker` | `codex_thread` | 只读授权路径并返回有界结论 |
| 新建、修改、移动或删除授权文件 | `repository_write` | `repository_write_worker` | `codex_thread` | 独占写入范围，不由协调窗口实施 |
| 运行命令、脚本、测试、构建、格式化、哈希或运行时检查 | `command_execution` | `execution_worker` | `codex_thread` | 原始输出留在 Thread，只返回摘要 |
| 检查 Git、审查差异、暂存、提交、推送或核对上游 | `git_operation` | `git_worker` | `codex_thread` | 遵守 `repo-execution` 与用户授权 |
| 运行官方 Skill 校验、安装一致性检查或安装根健康检查 | `skill_lifecycle_validation` | `skill_validation_worker` | `codex_thread` | 同时核验源码根与实际安装根 |
| 操作浏览器、读取页面或执行单 URL 预摄取 | `browser_local_operation` | `browser_worker` | `codex_thread` | 先健康检查，再本地预摄取和审批 |
| 进行架构、困难根因、安全敏感、超大上下文或外部模型推理 | `web_llm_reasoning` | `web_llm_provider` | `codex_thread` | Thread 承载 Browser Adapter，回执写 `model_source=web_provider` |
| 对工件、差异、测试或现场状态做独立验收 | `verification` | `verification_worker` | `codex_thread` | 只验证一到三个可证伪问题 |
| 发送、发布、删除、付款、账户变更或生产动作 | `domain_external_action` | `domain_action_worker` | `codex_thread` | 领域 Skill 独占身份、隐私、审批和成功证据 |

小任务、机械改动、确定性命令、只读元数据、单文件修改和快速校验都不构成协调 Agent 直接执行的例外。禁止 `subagent`、`spawn_agent`、等价 `Worker`、本地直做、协调窗口执行和任何非 Thread 兜底。

## Thread 创建与职责绑定

每个矩阵行的 `owner` 只是逻辑职责名。执行前必须为它一对一创建后台 `Codex App Thread`，并确认真实 `threadId` 与 `hostId`；只有真实双标识都可解析时才算成功。`clientThreadId` 只能表示准备中，必须先解析为真实 Thread，不能传给要求 `threadId` 的工具，也不能交由协调 Agent 接管。

仓库任务创建前，先用 `codex_app__list_projects` 按当前项目绝对路径选择项目记录；创建时必须使用 `target.type=project`、匹配的 `target.projectId` 和 `target.environment.type=local`。不得使用 `projectless`、聊天或 `chatgptWorkCloud` 目标。初始 prompt 必须标记 `TASK_KIND: work_task`，明确这是工作任务；Git 项目按 `isGitRepository` 使用本地 `worktree`（默认）或 `local`。

仓库任务固定执行：

1. `codex_app__list_projects`
2. `codex_app__create_thread(model, thinking, project, task packet)`
3. 确认真实 `threadId` 与 `hostId`
4. `codex_app__wait_threads`
5. `codex_app__read_thread`
6. 仅缺一个具体回执字段时，最多一次 `codex_app__send_message_to_thread`
7. 主 Agent 验收
8. `codex_app__set_thread_archived(threadId, hostId, archived=true)`，并确认返回已归档

任何 Thread 创建失败、标识不真实、回执缺失超过一个具体字段或验收冲突，都不得在协调窗口补做。按同一 `route_id` 递增 `attempt` 选择合格回退或返回 `blocked`。

## 串行、并行与组合

默认采用串行顺序，并用前序 `output_ref` 连接：

```text
repository_read_analysis
  -> repository_write
  -> command_execution
  -> skill_lifecycle_validation
  -> verification
```

只有同时满足以下条件才允许并行：至少两个范围真正独立、没有同一文件写入冲突、每个分支只有一个必需产物、不共享领域动作审批，并且延迟收益大于协调成本。每个分支必须有独立 Thread；同一分支内 Provider 链保持串行。

同一 Thread 可以顺序承担多个类别，但必须拥有完全明确的范围和权限、逐项返回验收结果、不跨越审批边界，并保持一个 `one_required_output` 和一个最终责任人。组合不能取消一对一 Thread 绑定，也不能把任何阶段退回协调 Agent。

## 不确定路线与回退

只要矩阵不能唯一确定 `work_class`、`owner`、`transport` 或拆分顺序，主 Agent 仍创建 `routing_consultation` Codex App Thread。该 Thread 使用当前配置的 Web-LLM Provider，并只返回路由建议；主 Agent 不自行猜测、判断或执行。

所有回退保持同一个 `route_id` 并递增 `attempt`：

| 失败条件 | 下一步 | 限制 |
|---|---|---|
| Thread 在读取输入前因传输不可用失败 | 创建一次同类别的合格 Thread | 不得泄露原始输入，协调 Agent 不接管 |
| 回执只缺一个具体字段 | 原 Thread 续问一次 | 不得重发完整输入 |
| 工件或结论失败 | 重新拆分合格 Thread 或 `blocked` | 不得退回本地直做 |
| URL 健康检查失败 | `blocked` | 不得打开 Chrome 或调用 Provider |
| URL 预摄取返回 `requires_user_approval` | 同一路由等待明确批准 | 不得自动选择 Provider |
| 已批准的具名 URL Provider 失败 | `blocked`，等待新的具名 Provider 审批 | 旧审批不能覆盖其他 Provider |
| 全部合格 Web-LLM 文本 Provider 失败 | 创建一次 `v4_fallback_thread` | 模型为 `deepseek-v4-pro-deepseek`，传输仍为 `codex_thread` |
| 全部合格 Web-LLM 视觉 Provider 失败 | `blocked` | 纯文本模型不能代替视觉证据 |
| `v4_fallback_thread` 失败 | `blocked` | 不得重新进入 Provider 链或由协调 Agent 接管 |
| 验收回执与执行回执冲突 | 原 Thread 续问一次或创建 `verification` Thread | 协调 Agent 不读取原始证据 |

`v4_fallback_thread` 不是主路由，也不是默认验收模型。更换 Thread、Provider、模型、职责或动作范围时必须重新核验审批；路由建议本身不授权执行或外部动作。

## 模型与 URL 规则

协调 Agent 保持“当前模型”表述，不固定或强调 Luna 身份。后台 Thread 的 `model` 与 `thinking` 由用户明确要求、路由策略或当前配置决定；`owner` 名称不等于模型名称。

对明确批准的单个 `http` 或 `https` URL，`browser_worker` 必须从实际安装根运行 `scripts/health-check.mjs`，再以 `allowExternalTransfer: false` 调用 `ingestSingleUrlWithLocalContext`。得到 `status: requires_user_approval` 后，只能针对具体页面数据和一个具名 Provider 请求批准；批准后同一路由只调用该 Provider 一次并设置 `allowExternalTransfer: true`。

原始页面数据、DOM、OCR、截图、Cookie、存储内容、查询令牌和临时路径必须留在浏览器 Thread 内。拒绝多 URL、通配符、分隔符技巧和跨来源重定向；具名 Provider 失败后不得沿用旧审批调用其他 Provider。
