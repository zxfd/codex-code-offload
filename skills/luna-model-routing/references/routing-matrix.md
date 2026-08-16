# Luna 路由矩阵

先判断是否需要拆分，再选择一个通用 contract。默认主 Agent 直接执行；只有独立性与净收益成立时才使用原生 subagent。

| 条件 | 执行者 | contract / 路由 | 约束 |
| --- | --- | --- | --- |
| 短小、确定性、强依赖或写入密集 | 主 Agent | local | 直接实现并验证 |
| 定位文件、symbol、调用链或日志边界 | 原生 subagent | `scout` | 默认只读，只返回范围与证据引用 |
| 多个真正独立的探索方向 | 最多 3 个原生 subagent | `scout` 并行 | 不做重复投票，不共享写入范围 |
| 800–2500 token 且跨文件/有歧义 | 主 Agent或 subagent | `reasoner`，按收益选择 Web-LLM | 先收窄输入 |
| >2500 token、3+ 文件/来源、200+ 行日志、长 OCR/文档 | subagent 或主 Agent | `reasoner → agentchat-code-offload` | Web-LLM 只推理 |
| 小 diff、短测试输出、低风险 | 主 Agent | local verification | 定点检查即可 |
| 大 diff、长日志、并发/权限/交易/数据库等高风险 | 原生 subagent | `verifier`，必要时 Web-LLM review | 返回可证伪检查，不直接改代码 |
| 源码修改、测试、Git、安装和最终验收 | 主 Agent | local execution | 主 Agent保留所有权 |
| 用户明确要求独立 App 任务 | Codex App task | `codex_app__create_thread` | 属于用户任务管理，不属于本 Skill 内部 subagent |

## 并行门槛

只有同时满足以下条件才并行：

- 至少两个范围真正独立；
- 每个分支有唯一 owner 和唯一产物；
- 没有同一文件或状态写入冲突；
- 并行能降低等待时间或隔离大量噪声；
- 协调成本低于收益。

否则串行或由主 Agent直接完成。原生 subagent 上限为 3；Web-LLM 默认并发 1，特殊最多 2。

## 回退

| 失败条件 | 下一步 |
| --- | --- |
| 原生 subagent 工具不可用 | 主 Agent直接完成任务 |
| subagent 回执缺一个字段 | 向原 subagent 最小续问一次 |
| subagent 失败但主 Agent具备权限与上下文 | 主 Agent定点接管或重新收窄任务 |
| Web-LLM 文本 Provider 全部失败 | 最多一次 `deepseek-v4-pro-deepseek` 回退 |
| Web-LLM 视觉 Provider 全部失败 | `blocked`，不得以纯文本替代像素证据 |
| 需要登录、验证码、具名敏感传输或高风险授权 | `needs_user_approval` |

不得因内部线程标识、`clientThreadId` 或 App 工作树准备状态要求用户介入；这些不是原生 subagent workflow 的组成部分。
