---
name: web-llm-page-extract
description: 对单个明确的 http/https URL 执行 web-ingest 提取与临时暂存，在同一受控浏览器上下文中获取经过边界化的必要 DOM，使用 macOS 剪贴板粘贴到指定 Web-LLM，并只在独立 Web-LLM Thread 中返回带来源 URL 和提取摘要的结构化数据；网页上下文不得进入本地模型或协调 Agent。触发于需要把未知网页交给 Web-LLM 理解、抽取或核对时。
---

# Web-LLM 页面提取

这是一个 Web-LLM-only 流程：网页上下文只在受控浏览器和 Web-LLM Thread 内流转。它不调用本地模型，不把完整 DOM、页面正文、Cookie、存储内容或剪贴板内容复制到主协调 Agent。

## 固定顺序

1. 只接受一个明确的 http 或 https URL。拒绝多 URL、通配符、分隔符拼接和跨来源重定向。
2. 先确认实际安装根（通常是 ~/.agents/skills/web-ingest），再从该安装根运行 scripts/health-check.mjs --root <installed-root>；找不到安装副本时停止，不能把仓库源码目录冒充安装根。健康检查通过后再调用其 extractAndStageSingleUrl(options)；ingestSingleUrlWithLocalContext 只是兼容别名。健康检查或提取状态不是 staged 时立即停止。
3. 用 readStagedIngestResult(temporaryFilePath) 读取有界结果，并在外层 try/finally 中尽快调用 cleanupStagedIngestResult(temporaryFilePath)。标准 result.json 只包含有界可见信号和视觉摘要，不包含完整 DOM；不得声称完整 DOM 来自 result.json。
4. 如果任务确实需要 DOM，必须在提取所用的同一个受控浏览器上下文内选择一个明确、可见、同源、任务必要的子树，并另写一个受限 DOM 工件。禁止选择 html、head、body 或整页快照，禁止跨来源二次打开。DOM 工件至少包含：

   {
     "domSource": "controlled-browser-same-origin",
     "sameContext": true,
     "domComplete": false,
     "sourceUrl": "https://example.test/page",
     "domScope": "article[data-task-section]",
     "domText": "<article data-task-section>...</article>"
   }

   domText 是经过边界化的选中子树序列化文本，不是完整文档。可通过 extractAndStageSingleUrl 的 extractSignals 钩子在该 tab 内同步写出这个工件；不要在函数返回后重新导航或用第二个页面猜测 DOM。选择器、来源、风险状态和大小必须在同一浏览器操作中确认；如果不能证明同一上下文或必要范围，停止。
5. 使用本 Skill 的 scripts/copy-dom-to-clipboard.mjs 校验并写入 macOS 系统剪贴板。该脚本只接受绝对路径、受管临时目录中的普通文件、上述同上下文标记和有界 domText；它只写 text/plain，不写 HTML/MIME 富文本。写入失败时不打开或调用 Web-LLM。
6. 在独立 Web-LLM Thread 中使用受控 Chrome 打开指定且已批准的 Web-LLM。健康检查、登录/页面不可用、剪贴板不可用、粘贴失败或响应等待失败都必须 fail-closed。将剪贴板内容粘贴到固定 composer 后提交以下短指令：

   你将收到一段来自 source_url 的边界化 DOM 纯文本。
   只提取任务要求的数据，不补造缺失值，不输出 DOM 原文。
   严格返回 JSON：{"source_url":"...","extraction_summary":"...","data":{...}}
   source_url 必须与提供的来源 URL 完全一致；若上下文不足、内容不完整或无法结构化，返回 {"status":"blocked","reason":"..."}。

   通过受控浏览器执行粘贴、发送和响应确认；不要把 DOM 读回主 Agent。必须在回执中标记 model_source=web_provider，并确认是当前请求的新 assistant 响应，而不是旧消息。
7. 在 runner 返回成功前，为 `runProviderFallback` 传入唯一 Provider 的 `responseValidator`，调用本 Skill 的 `scripts/structured-response.mjs`：

   ```js
   requestMetadata: { require_structured_response: true, structured_response_format_retry: true },
   responseValidator: ({ answer }) => parseStructuredAssistantResponse(answer, { requestUrl })
   ```

   该校验器只返回脱敏结构化对象，不返回 assistant 原文、DOM 或网页正文；runner 只有在 `response_is_new`、响应/生成完成和完整 JSON 均通过后才写入成功事件、健康缓存并清理会话。
8. 如果当前请求的新 assistant 已确认且生成完成，但严格解析仅因不完整 JSON、截断包装或多 JSON 包装失败，runner 在同一个已批准 Provider 的同一会话中最多发送一次短格式修复提示：只返回 JSON.stringify 风格的完整裸 JSON，不得 Markdown、code fence 或说明，并正确转义字符串。`structured_response_format_retry` 默认开启，设为 `false` 可关闭，不能把上限提高到一次以上。随后必须再次确认新的 assistant 响应并严格解析；回执标记 `attempt`、`responseConfirmation`、`response_complete`。重试不上传图片、不切换 Provider、不调用本地模型。
9. 缺字段、来源不一致、`status: blocked`、旧 assistant、响应未完成、导航/发送失败或第二次解析失败都不重试；成功事件、健康缓存和会话终态清理只在重试后的新 JSON 通过后发生。失败只返回有界错误类别，不返回 assistant 原文、DOM 或网页正文。

## 复用现有适配器

优先复用仓库已有的 Web-LLM 生命周期和 Provider 适配器：

- 浏览器入口使用 skill/scripts/browser-client-entry.mjs 的 resolveBrowserClientEntry()，并固定 browserChannel: chrome；不要自行拼接插件缓存路径。
- Provider 编排使用已安装 agentchat-code-offload 的 skill/scripts/web-provider-runner.mjs 的 runProviderFallback 及对应 skill/scripts/providers/*.mjs。本流程必须把配置收窄为一个用户明确批准的 Provider，验证该 route 只有该 Provider 且 local_fallback: false；不要沿用通用 fallback 链，也不要调用本地模型。
- 适配器负责新会话、固定 composer、发送、当前请求的 responseConfirmed 和终态清理。不要新增一套 Provider runner、通用 DOM 选择器或让 Web-LLM 自己决定下一步浏览器动作。
- 所有 Provider 结果必须同时提供 `responseConfirmed`、`response_confirmed`、`response_is_new`、`generationComplete` 和 `structuredJsonAvailable` 及其 snake_case 兼容字段；缺字段不得视为成功。`response_is_new` 表示本次请求创建的新 assistant 消息，不是非空文本或旧消息匹配。
- 粘贴动作必须留在受控浏览器中：聚焦固定 composer，执行 ControlOrMeta+V，等待可见输入/提交状态，再等待新 assistant 响应。剪贴板内容和完整 DOM 不进入 Web-LLM Thread 之外的日志或回执。

Web-LLM Thread 的最小回执应包含 model_source=web_provider、具名 provider、responseConfirmed=true、来源 URL、提取摘要和结构化数据；失败只返回失败类别，不返回网页正文或 DOM。

## 脚本

`scripts/structured-response.mjs` 只从当前已确认的新 assistant 文本中提取一个完整 JSON 对象；允许 BOM/空白、单层 Markdown code fence 和有限前后说明，但仍使用严格 `JSON.parse`，不修复未转义 JSON 字符串、Markdown 链接或 selector。它严格校验 `source_url`、`extraction_summary`、`data.target` 与 `data.selector`，并拒绝旧响应（由 runner 的 request-scoped 元数据闸门判定）、来源不一致、缺字段和 `status: blocked`。仅 `not_a_complete_json_object`、截断或多对象包装这类语法失败可触发一次格式重试。

    node /absolute/path/to/skills/web-llm-page-extract/scripts/copy-dom-to-clipboard.mjs \
      --input /absolute/path/to/codex-web-llm-page-extract-XXXX/dom.json

离线验证可加 --dry-run，它仍执行所有路径、来源、敏感内容和大小检查，但不调用 pbcopy。默认上限为 2,000,000 字节，不能通过参数提高。脚本在非 macOS 上以清晰错误退出；不模拟系统剪贴板，也不绕过登录、凭证或隐私风险。

## Fail-closed 与清理

健康检查、URL/同源校验、web-ingest 敏感扫描、同上下文 DOM 边界、脚本校验、剪贴板写入、Web-LLM 页面状态、粘贴状态、当前响应确认和 JSON 结构化任一环节失败，都必须停止。不要在失败后改走本地模型、未批准 Provider、额外 URL 或整页 DOM。

把暂存结果和 DOM 工件都放进调用方的 try/finally：先保存有限的状态/哈希/来源摘要，再调用对应 cleanup；清理失败也要在回执中报告，不能把工件路径当作成功。真实网页发送不属于本 Skill 的离线测试范围，不能用静态检查宣称端到端成功。
