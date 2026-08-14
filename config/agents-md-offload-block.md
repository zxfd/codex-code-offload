# 全局 AGENTS.md 路由片段

将此片段追加到全局 `AGENTS.md`（Codex 的 `~/.codex/AGENTS.md`，若走 Seafile 同步则合并到其真实目标），
让 Codex 先由 `luna-model-routing` 进行模型判定，再按 transport 进入 Codex 内部模型 Thread
或 `agentchat-code-offload` 的 Browser Adapter。详细阈值、Thread 生命周期、Provider UI 细节与
多模态规则分别收进对应 Skill，避免全局规则堆叠。

```markdown
## Luna 模型协作路由

- 主模型固定为 `gpt-5.6-luna`；Luna 负责判定、任务包、Thread/Browser Adapter 通信、回退、核验、修改和测试。
- 确定性命令、测试、格式化、精确补丁和元数据操作留在当前 Luna 任务，不为“复杂”标签自动派遣。
- Spark 有独立额外额度；只有 Luna 已判定值得开启内部 Thread 时，才优先把符合条件的低风险文本任务交给 Spark，不能为了消耗额度而派遣。
- Spark、DeepSeek V4 Flash、DeepSeek V4 Pro 通过 `codex_thread` 通信；Web-LLM 通过 `browser_adapter` 通信。两者共享任务包与回执字段，但不得混淆 transport。
- Web-LLM 仅负责只读分析，Provider 顺序和多模态附件规则继续由 `providers.json` 与 `agentchat-code-offload` Skill 管理。
- 对 `execution_mode: serial` 的纯文本任务，Web-LLM 全部 Provider 失败后只允许尝试一次 DeepSeek V4 Pro；视觉/OCR 任务不得把纯文本 V4 Pro 当作视觉回退。
- 对 `execution_mode: parallel` 的分支失败，不自动创建 V4 Pro replacement，由 Luna 根据任务账本和验收依赖决定。
- 大段源码、OCR、日志或文档由本地预处理后直接进入选定 transport，避免整包内容回灌当前 Luna 上下文。
- 所有内部模型和 Web-LLM 结果都是待核验证据；未得到本地核验前不得修改、测试或执行高风险动作。
```
