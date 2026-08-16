# 通用任务契约与成本门控

本契约是第一版稳定接口，不创建自定义 Agent profile，也不依赖未公开的 Multi-Agent feature flag。

## 三类职责

| contract | 适用任务 | 必须返回 |
| --- | --- | --- |
| `scout` | 只读探索、代码/日志定位、候选证据收集 | `findings`、`evidence_refs`、`unresolved` |
| `reasoner` | 跨文件综合、根因判断、方案取舍和超过 token gate 的重推理 | `conclusion`、`assumptions`、`evidence_refs`、`unresolved` |
| `verifier` | 对实现、配置、测试或运行态做独立可证伪核验 | `checks`、`result`、`evidence_refs`、`unresolved` |

默认流程是 `scout → reasoner → verifier`，但不是每个任务都必须走完三步。主 Agent可直接跳过没有净收益的角色。

## 模型与并发

- 主 Agent：`gpt-5.6-luna`，`medium`。
- 原生 subagent：`gpt-5.6-luna`，`low`，最多 3 个并发。
- Web-LLM：默认并发 1；范围明确且互不依赖时最多 2；单分支 Provider 链保持串行。
- 写入默认由主 Agent串行完成；subagent 写入必须拥有明确且不重叠的路径。
- 并发用于上下文隔离或降低等待，不用于相同输入的模型投票。

## Token gate

- SMALL：少于约 800 输入 token、最多两个短片段且无需跨源综合，由主 Agent或 scout 本地完成。
- MEDIUM：约 800–2500 token；跨文件、存在歧义、需要综合或预计再次读取大段上下文时，按收益选择 Web-LLM。
- LARGE：超过约 2500 token、至少 3 个相关文件/来源、超过约 200 行日志、长 OCR/文档或实质架构/根因推理，默认交给 Web-LLM。

Web-LLM 只负责推理。成功回执必须标记 `model_source=web_provider` 与 `request_id`；所有合格文本 Provider 失败后才允许一次 `deepseek-v4-pro-deepseek` 回退。纯文本回退不能替代视觉证据。
