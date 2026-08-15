---
name: luna-model-routing
description: 强制把当前会话限制为控制面，并把源码、文件、命令、测试、Git、Skill 校验、浏览器、Web-LLM 推理和领域动作全部交给独立 Codex App Thread。用于模型选择、跨模型通信、仓库或长上下文卸载、Web-LLM 免费优先路由，以及串行或并行回退决策。
---

# 模型路由规则

本 Skill 规定 `Thread-only` 路由。把“当前会话窗口”“主 Agent”“协调 Agent”视为同一角色；该角色只运行控制面，不执行任务工作。

`Worker` 只是逻辑职责。每个 `Worker` 必须一对一绑定一个由 `codex_app__create_thread` 创建的后台 `Codex App Thread`，不能把逻辑职责当成执行载体。内部执行载体只有独立的 `Codex App Thread`。

禁止 `subagent`、`spawn_agent`、等价 `Worker`、本地直做、协调窗口执行和任何非 Thread 兜底。`Worker` 名称不等于模型名称；不要把 `luna-model-routing`、负责人名称或历史路由名称当成当前模型身份。

本 Skill 只规定职责划分、任务包、Thread 生命周期、传输、回执、回退和验收状态；不替代 `skill-creator`、`repo-execution` 或任何领域 Skill，也不产生、复制、转移或放宽审批。

## 协调 Agent 的唯一职责

协调 Agent 只能按以下边界工作：

1. 读取当前生效的 `AGENTS.md`、本次触发的 `SKILL.md`，以及这些 Skill 明确选定的必需引用。
2. 根据用户目标和控制规则拆解任务，为每个任务确定 `work_class`、`owner`、`transport` 和验收字段。
3. 按 [通信契约](references/communication-contract.md) 创建独立 `Codex App Thread`，发送任务包并分发工作。
4. 使用 Thread 工具等待和读取有界回执；回执只缺一个具体字段时，向原 Thread 发送一次最小续问。
5. 只依据回执结构、`output_ref`、工件指纹、测试或校验摘要和允许读取的控制内容完成验收。
6. 验收通过后归档对应 Thread，并向用户交付结果。

除上述职责外，协调 Agent 不得亲自处理任何任务证据。它不得搜索或读取源码、配置、文档、日志、测试、数据库、页面、DOM、OCR、图片或工件正文；不得检查工作区、分支、差异、哈希、安装根、进程或运行时状态；不得编辑文件、运行命令、测试、构建、格式化、Git、安装、健康检查、浏览器、Browser Adapter、Provider 或领域系统；不得在失败后接管、复跑或重新分析。

即使任务很小、改动机械、命令确定、路径已知、只读检查或只有一个文件，也必须创建独立 Thread。看似本地或确定性不构成豁免。

如果 Worker 返回源码、完整差异、长日志、页面正文、DOM、OCR、截图、令牌或其他原始证据，协调 Agent 不读取和分析这些内容；将回执标为 `rejected`，只允许原 Thread 进行一次有界重发。

## 先读取控制规则，再分发

每次启用本 Skill 时，先读取本 Skill 的 [通信契约](references/communication-contract.md)；需要选择负责人、模型、推理强度、串并行或回退时，再读取 [路由矩阵](references/routing-matrix.md)。协调 Agent 只读取生效 `AGENTS.md`、已触发 Skill 和明确选定的必需引用，不把任务证据装入协调上下文。

只通过 `inputs_by_reference` 传递字面路径、前序 `output_ref` 或必要的控制引用，让 Thread 内的 Worker 自行读取。任务包必须有一个 `one_required_output`，并明确 `owned_paths`、`approval_source`、`acceptance_criteria`、`coordinator_forbidden` 和 `constraints`。

如果无法确定 `work_class`、`owner`、`transport` 或拆分方式，主 Agent 仍必须创建 `routing_consultation` Codex App Thread。该 Thread 内的 Browser Adapter 只能调用已配置的 Web-LLM Provider 提供路由建议；主 Agent 不得自行判断、执行、改派或把咨询当成授权。

## 唯一 Thread 生命周期

### 创建前硬约束

每次仓库任务都必须先绑定“发起调用所在的本地项目”，而不是协调窗口、父任务或当前聊天窗口所在的项目。任务包必须携带调用方项目的两个不可替代字段：

```text
caller_project_id = <发起调用方项目的 projectId>
caller_project_path = <发起调用方项目的绝对路径引用>
```

调用方来自其他项目时，必须原样传递该调用方的 `projectId` 和项目路径引用；协调 Agent 不得用自己的项目、父任务项目、项目名或历史路由结果替换它。缺少任一字段、字段无法解析，或无法由 `codex_app__list_projects` 返回记录按规范化绝对路径精确匹配时，必须 `fail-closed`，不得创建 Thread。

创建仓库 Worker Thread 前，必须先用 `codex_app__list_projects` 选择与 `caller_project_path` 精确匹配且 `projectId` 等于 `caller_project_id` 的项目记录；不得凭项目名猜测，也不得选择无项目的 `projectless`、聊天或 ChatGPT Work 云端目标。

创建必须使用项目型本地目标，等价于：

```text
target.type = project
target.projectId = <list_projects 返回且与 caller_project_path 匹配的 caller_project_id>
target.environment.type = local
```

任务包的初始 prompt 必须明确 `TASK_KIND: work_task`，并写明调用方仓库路径、允许范围和验收条件；不得使用“聊天”“chat”或其他仅会话语义替代工作任务。若项目是 Git 仓库，遵循调用方项目记录的 `isGitRepository` 规则选择 `worktree`，否则使用 `local`；两者都必须保持在调用方项目的本地环境内。

创建返回后，必须在进入等待和读取前确认真实 `threadId`、`hostId`，并核对 Thread 返回的项目身份与 `caller_project_id`、`caller_project_path` 一致。项目类型不是 `project`、环境不是 `local`、项目 ID 缺失或不一致、项目路径无法解析或不一致，均为 `fail-closed`；不得在错误归属 Thread 中运行、验收或把它当作成功结果。

仓库任务需要路由时，严格按以下顺序执行，不得跳过、替换或插入非 Thread 载体：

1. `codex_app__list_projects`
2. `codex_app__create_thread(model, thinking, project, task packet)`
3. 确认真实 `threadId` 和 `hostId`
4. `codex_app__wait_threads`
5. `codex_app__read_thread`
6. 仅在回执缺少一个具体字段时，最多一次 `codex_app__send_message_to_thread`
7. 主 Agent 验收
8. `codex_app__set_thread_archived(threadId, hostId, archived=true)`，并确认返回状态仍为已归档

每个 `Worker` 都必须遵守同一生命周期；`model`、`thinking`、`project` 和任务包随实际任务填写。只有 `codex_app__create_thread` 返回且可被后续 Thread 工具解析的真实 `threadId` 与 `hostId` 才算创建成功。空值、占位值、不可读取状态或只有 `clientThreadId` 都只能表示准备中。

`clientThreadId` 必须先解析为真实 Thread，不能传给要求 `threadId` 的工具，也不能据此报告成功、开始验收或转交给协调窗口。解析失败时按回退矩阵返回 `blocked`；协调 Agent 不接管。

等待期间不得在协调窗口并行执行已分发工作。一次具体续问只能发送缺失字段，不能重发完整输入，不能创建替代路线来绕过 Thread 生命周期。

## 统一传输与职责

所有内部 `work_class` 的 `transport` 统一为 `codex_thread`。由 `work_class` 和 `owner` 区分职责；分析、写入、命令、校验、浏览器、验收和领域动作不是不同传输。每一种职责都必须绑定自己的独立 Codex App Thread。

Web-LLM 同样运行在独立 Codex App Thread 中，由该 Thread 承载 Browser Adapter；回执记录 `model_source=web_provider`。Provider 是 Thread 内的模型来源，不是另一种 `transport`，不能把宿主 Codex 文本冒充 Provider 结果。

每个独立并行分支使用一个 Thread，分支内的 Provider 链保持串行；默认使用串行。不得为同一分支的每个 Provider 另建载体，不得把相同输入交给模型评审组。

## 模型、回退与审批

主 Agent 使用“当前模型”表述并保持当前运行时模型与强度；后台 Thread 的 `model` 和 `thinking` 由用户明确要求、路由策略或当前配置决定。不要把 `owner`、Worker 名称和模型名称绑定。

符合条件的 Web-LLM Provider 链全部失败后，才允许创建一次 `v4_fallback_thread` Codex App Thread，使用纯文本模型 `deepseek-v4-pro-deepseek`；该 Thread 仍使用 `transport=codex_thread`，不是默认模型、默认验收者或主路由。该次回退失败后返回 `blocked`，不得重新进入 Provider 链，也不得由协调 Agent 接管。

路由只记录 `approval_source`，不产生审批。分析、读取、写入、测试、Git、Skill 校验和路由咨询的批准，都不等于发送、发布、删除、付款、账户变更或生产动作批准。更换 Thread、Provider、路由或动作范围时，必须重新核验适用审批。

## 新 Chrome 任务的 URL 摄取门

对于用户明确批准的单个 `http` 或 `https` URL，协调 Agent 将完整流程交给 `browser_local_operation` Thread；协调 Agent 不运行健康检查、不打开 Chrome、不调用摄取函数和 Provider。

`browser_worker` 必须先从实际安装根运行 `scripts/health-check.mjs`。失败时 `fail-closed`，不得打开 Chrome 或调用 Provider。随后通过 `ingestSingleUrlWithLocalContext` 先使用以下本地上下文参数：

```text
{
  allowText: true,
  allowVisual: true,
  allowExternalTransfer: false,
  maxImages: 4,
}
```

预期返回 `status: requires_user_approval` 的有界回执，并针对具体页面数据和一个具名 Provider 请求用户明确批准。获得批准后，在同一路由再次调用辅助函数，设置 `allowExternalTransfer: true`，并将 `runProvider` 限定为该具名 Provider 一次调用。

这是一个两步路由。拒绝多个 URL、通配符、分隔符技巧和跨来源重定向；原始 DOM、页面正文、OCR、截图、Cookie、存储内容、查询令牌和临时路径不得进入协调上下文。已批准的具名 Provider 失败时停止并请求新的具名 Provider 审批，不得沿用旧审批调用其他 Provider 或正常回退链。

详细字段、回执和回退约束见 [通信契约](references/communication-contract.md)；负责人、模型、串并行和回退选择见 [路由矩阵](references/routing-matrix.md)。
