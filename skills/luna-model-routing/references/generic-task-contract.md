# 通用任务契约与成本门控

本契约是第一版的稳定任务接口。它描述职责和路由边界，不创建自定义 Agent profile，也不要求调用方启用未公开的 Multi-Agent feature flag。

## 三类通用职责

| contract | 适用任务 | 必须返回 |
| --- | --- | --- |
| `scout` | 只读探索、代码/日志定位、候选证据收集 | `findings`、`evidence_refs`、`unresolved` |
| `reasoner` | 跨文件综合、根因判断、方案取舍和超过 token gate 的重推理 | `conclusion`、`assumptions`、`evidence_refs`、`unresolved` |
| `verifier` | 对实现、配置、测试或运行态做独立可证伪核验 | `checks`、`result`、`evidence_refs`、`unresolved` |

每个任务只能有一个 contract 和一个 `owner`，必须使用 `codex_thread`。任务输入通过路径或 `output_ref` 引用传递；回执只携带有界字段，不复制源码、完整 diff、长日志、DOM、OCR、Cookie 或令牌。

## 默认工作流

```text
scout (可并行，最多 3 个原生子任务)
  -> reasoner (需要综合或超过 gate 时走 Web-LLM)
  -> verifier (独立核验)
```

只有范围真正独立、没有同一文件写入冲突且每个分支只有一个产物时才并行。写入任务默认串行；多个任务不得同时改同一代码区域。

## 模型与并发预算

- 主控模型：当前配置固定为 `gpt-5.6-luna`，推理强度 `medium`。
- 原生子任务：`gpt-5.6-luna`，推理强度 `low`，最多 3 个并发；这是路由契约，只有 Codex 官方配置公开对应字段时才可写入配置。
- Web-LLM：默认并发 1；只有明确、互不依赖且当前官方配置已验证支持时才允许最多 2。Provider 链在单个分支内保持串行。
- 不得把 `multi_agent_v2` 当作可用配置键硬写入；不得凭 `max_*`、`parallel_*` 或 `concurrency_*` 名称猜测不存在的官方字段。
- 子任务的 token 和工具调用独立计费。默认优先低成本 scout；并发只用于降低上下文污染或等待时间，不能用于投票式重复调用。

## Token gate 与 Web-LLM

- SMALL：约少于 800 个输入 token、最多两个短片段且无需跨源综合，留在本地。
- MEDIUM：约 800–2500 个输入 token；跨文件、存在歧义、需要综合或预计会再次读取大段上下文时，才按收益选择 Web-LLM。
- LARGE：超过约 2500 个输入 token、至少 3 个相关文件/来源、超过约 200 行日志，或需要实质架构/根因推理时，默认将 `reasoner` 路由到 Web-LLM。

Web-LLM 只负责推理，不负责执行；回执必须标记 `model_source=web_provider` 和 `request_id`。所有合格 Provider 失败后，才允许一次 `deepseek-v4-pro-deepseek` 纯文本回退；回退失败即 `blocked`。不能把宿主模型输出冒充 Web-LLM 结果，也不能用纯文本回退代替缺失的视觉证据。
