# 全局 AGENTS.md 路由片段

将下列片段语义合并到全局 `AGENTS.md`。详细 token gate、任务回执与回退边界由实际安装的
`luna-model-routing` Skill 管理，Provider 与多模态规则由 `agentchat-code-offload` 管理。

```markdown
## Luna / Multi-Agent / Web-LLM 路由

- 主控默认使用当前配置的 `gpt-5.6-luna` 与 `medium`；主 Agent保留源码修改、命令、测试、Git 和最终验收。
- 只有真正独立、边界清晰且隔离或并行收益为正时，才使用原生 Codex subagents；通用角色为 `scout`、`reasoner`、`verifier`，默认 Luna low，最多 3 个并发。
- 不使用 `codex_app__create_thread` 模拟内部 subagent，不依赖 `clientThreadId` 解析，不创建自定义 `.codex/agents` profile，也不硬开 `multi_agent_v2`。
- 短小、确定性、写入密集或强依赖任务由主 Agent直接完成；写入默认串行，多个 Agent 不同时修改同一代码区域。
- 超过 token gate 或需要跨文件/跨来源重推理时，优先使用 `agentchat-code-offload` 的 Web-LLM；默认并发 1，互不依赖且运行时已验证时最多 2，单分支 Provider 链串行。
- Web-LLM 只负责推理，主 Agent必须本地核验后才执行。所有合格 Web Provider 失败后才允许一次 `deepseek-v4-pro-deepseek` 纯文本回退；纯文本回退不能替代视觉证据。
```
