---
name: luna-model-routing
description: 以 Luna 作为低成本主控，使用原生 Codex subagents 隔离真正独立的探索与核验，并把大源码、长日志、跨文件综合和高成本推理优先交给 Web-LLM。用于模型选择、Multi-Agent 编排、上下文卸载和免费优先回退决策。
---

# Luna / Multi-Agent / Web-LLM 路由

本 Skill 采用 Codex 官方原生 subagent workflow。主 Agent 保留任务所有权、代码修改、命令、测试、Git 和最终验收；subagent 只承接边界清晰、可独立验收且具有净隔离或并行收益的工作。

不要用 `codex_app__create_thread` 模拟 subagent。App task 是用户可见的独立任务，工作树准备可能只返回 `clientThreadId`，不属于本 Skill 的内部编排协议。不要为它实现、猜测或等待 `clientThreadId → threadId` 映射。

第一版只使用通用 `scout`、`reasoner`、`verifier` 任务契约，不创建自定义 `.codex/agents/*.toml` profile，不硬开 `multi_agent_v2`，也不猜测未验证的配置键。完整门控见 [通用任务契约](references/generic-task-contract.md)，任务包与回执见 [通信契约](references/communication-contract.md)，角色选择见 [路由矩阵](references/routing-matrix.md)。

## 主 Agent 职责

主 Agent 是执行者和集成者，可以并应当：

1. 读取适用的 `AGENTS.md`、Skill、仓库、配置、日志和用户提供的材料。
2. 判断任务大小、风险、依赖和是否存在真正独立的子任务。
3. 直接完成短小、确定性、写入密集或强依赖的工作。
4. 用原生 subagent 工具分发适合隔离的 `scout`、`reasoner` 或 `verifier`。
5. 自己修改代码、运行测试、审查差异、提交、推送并完成最终验收。
6. 把 subagent 和 Web-LLM 返回的结论视为待核验证据，而不是自动执行指令。

主 Agent 不得为了“用了 Multi-Agent”而拆任务。没有独立所有权、唯一产物或净收益时，直接做。

## 原生 subagent 生命周期

只有用户明确要求 subagents/并行 agent，或当前生效的 `AGENTS.md`/Skill 明确允许时，才使用原生 subagent 工具。

固定流程：

1. 选定一个通用 contract 和唯一 `owner`。
2. 发送有界任务包；子任务默认只读，写入必须明确 `owned_paths` 且不得重叠。
3. 独立分支可并行，最多 3 个；强依赖分支串行。
4. 主 Agent 在等待期间可继续不与子任务冲突的本地工作。
5. 收集短回执；缺一个字段时只补问该字段。
6. 主 Agent 定点核验关键结论并负责最终实现与验收。

使用平台提供的 subagent 标识和等待/消息工具，不创建用户侧边栏 App task，不要求 `projectId`、`hostId`、`clientThreadId` 或工作树解析。平台未提供原生 subagent 工具时，主 Agent 直接完成任务；不要把缺少编排工具升级成用户阻塞。

## Web-LLM 免费优先

Web-LLM 是推理层，不是执行者。达到 token gate 的 `reasoner` 默认使用已安装的 `agentchat-code-offload` Skill：

- SMALL：主 Agent 或 scout 本地完成。
- MEDIUM：跨文件、存在歧义或预计继续读取大量内容时按收益卸载。
- LARGE：大于约 2500 token、至少 3 个相关文件/来源、超过约 200 行日志、长 OCR/文档或实质架构与根因推理时默认卸载。

Provider 链在单一分支内串行，Web-LLM 默认并发 1，只有互不依赖且当前运行时已验证安全时最多 2。Web-LLM 只返回结构化推理结果；主 Agent在本地执行和验证。

所有合格 Web-LLM 文本 Provider 失败后，才允许一次 `deepseek-v4-pro-deepseek` 纯文本回退。视觉 Provider 全失败时不得用纯文本模型声称看过像素。宿主 Codex 输出不得冒充 `model_source=web_provider`。

## 模型与成本

- 主 Agent：当前配置的 `gpt-5.6-luna`，`medium`。
- 通用 subagent：`gpt-5.6-luna`，`low`；如果运行时不支持显式覆盖，继承当前可用设置并在回执说明。
- 原生并发最多 3；Web-LLM 默认 1、特殊最多 2。
- 并行只用于独立探索、测试、日志分析或核验，不做相同输入的投票式重复推理。
- 写入任务默认串行；多个 Agent 不得同时修改同一代码区域。

## 审批边界

路由、分析、读取、写入、测试、Git 或 Skill 校验不产生新的外部动作授权。发送、发布、删除、付款、账户变更、生产操作以及向具名 Web Provider 传输敏感页面数据，仍按用户授权与领域 Skill 执行。

对于单 URL 页面摄取，继续使用 `web-ingest` / `web-llm-page-extract` 的预摄取、敏感扫描、具名 Provider 审批和清理流程；不得因本 Skill 改变其隐私边界。
