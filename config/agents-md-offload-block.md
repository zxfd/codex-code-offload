# 全局 AGENTS.md 路由片段

将此片段追加到全局 `AGENTS.md`（Codex 的 `~/.codex/AGENTS.md`，若走 Seafile 同步则合并到其真实目标），
让 Codex 对大型代码/文档/OCR 分析默认走 `agentchat-code-offload`。详细阈值、Provider UI 细节与
多模态规则已收进 Skill，避免全局规则堆叠。

```markdown
## 代码推理卸载

- 分流的首要目标是减少 Codex 主模型 token，同时兼顾网页往返、失败回退和本地核验成本；不以最快为唯一目标。判断成本时要区分“本地工具执行”与“把工具输出读入 Codex 上下文”：前者通常不耗模型 token，后者可能很昂贵。
- 预计需要进入 Codex 的原始内容少于约 800 token，且只需直接判断或机械操作时，优先本地；约 800–2500 token 时按跨文件/跨页面综合、歧义和视觉依赖决定；超过约 2500 token、涉及至少 3 个相关文件/来源或需要读取长日志/长 OCR 时，默认优先使用全局 `agentchat-code-offload` Skill。
- git/test/lint/build/formatter、文件移动和确定性的短修改由本地工具执行；若其输出很长，只在本地提取最小证据，或让本地预处理结果直接进入 Web LLM，不把全文先装入 Codex。
- 调用 Web LLM 时按内容类型执行配置的 Provider 优先级：纯文本默认为 ChatGPT GPT-5.6 Sol Extra High → DeepSeek 专家模式 → Qwen3.8-Max（仅回退一次到 Qwen3.7-Max）→ Gemini Pro 扩展思考；多模态默认为 ChatGPT → Gemini Pro 扩展思考 → Qwen3.8-Max（仅回退一次到 Qwen3.7-Plus）→ 本地。具体路由与模型约束以 `providers.json` 和 `agentchat-code-offload` Skill 为准，不得恢复 VibeX。
- OCR 按预计 Codex 上下文消耗分流：单个清晰短区域且结果少于约 800 token 时本地；长篇、批量、手写、模糊、表格、多栏、图文混排或需要语境纠错时优先 Web LLM。本地可以负责裁剪、打码、渲染或初步 OCR，但大段结果应直接送往 Web LLM，不先进入 Codex。
- 多模态分流包括 OCR、截图故障分析、界面/图表/示意图理解、跨图比较和少量页面图的版式推理。音频、视频及原始 PDF/DOCX 仍不按图片直接外发；文档先本地提取，只有视觉或 OCR 质量依赖原图时才发送最少页面图。
- `modality: 'multimodal'` 只表示路由资格，不代表媒体已经上传。只有任务范围内的非敏感图片已通过 Provider 的可见附件控件提交并确认就绪，才可把结果记为多模态成功；附件无法确认时必须回退，不得退化为纯文本后冒充看过图片。
- Codex 应先用搜索、symbol、路径、计数和少量局部上下文估算输入规模并定位范围，再由本地 offload 工具读取和发送完整的选定上下文，避免大段源码、OCR、日志或文档正文进入 Codex 主上下文。
- Web LLM 只负责分析与推理，其输出视为未经验证的假设；Codex 负责本地核验、修改和测试。
- 不默认并行调用多个 Web LLM；只有高风险、低置信度、结论冲突或多次失败时才使用第二模型复核。
```

