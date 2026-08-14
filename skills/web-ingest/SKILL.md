---
name: web-ingest
description: 通用单 URL 页面本地预摄取 Skill，提取有界文本与视觉信号，执行同源重定向、隐私风险和临时工件清理，并在任何外传前要求明确审批。用于需要安全读取一个已授权网页、判断页面上下文或为后续模型分析准备最小上下文的任务。
---

# 通用页面摄取

## 工作边界

仅处理一个明确的 `http` 或 `https` URL。先在本地受控浏览器中打开页面，读取有界的可见文本和必要的视觉区域；不接受通配符、多个 URL、分隔符拼接或跨来源重定向。

默认使用 `{ allowText: true, allowVisual: true, allowExternalTransfer: false, maxImages: 4 }`。本地预摄取不得向外部 Provider 发送页面内容，返回 `requires_user_approval` 的摘要状态供后续审批判断。

## 摄取流程

1. 先运行 `scripts/health-check.mjs`，从实际安装根检查 `SKILL.md`、核心脚本和公开导出；失败即停止，不打开页面、不调用 Provider。
2. 验证输入是单个绝对 URL，并用受控浏览器导航。最终 URL 必须与原始 URL 同源；跨域重定向直接失败且不得外传。
3. 在页面本地提取可见文本、标题、图片/Canvas/表格计数和有界视觉区域。文本、提示词、图片文件均限制大小并写入权限为 `0700/0600` 的临时工作区。
4. 对文本执行凭证、登录提示和个人信息扫描；对视觉路径、标题、替代文本和文本信号执行敏感视觉扫描。高风险内容阻断外传，视觉风险返回审批状态。
5. 仅当 `allowExternalTransfer: true` 且调用方显式传入具名 `runProvider` 时才允许外传。缺少 `runProvider` 必须 fail-closed；本 Skill 不选择 Provider、不实现 Provider fallback，也不包含网站专用选择器。
6. Provider 返回以 `NEED_MORE_CONTEXT` 开头的答案时保留临时工件，返回 `requires_user_approval` 和 `fullNeedsMoreContext: true`；其他终局或失败路径都清理提示词、图片和工作区，并关闭页面标签。

## 外传审批与续上下文

把本地预摄取结果视为审批材料，不把原始 DOM、HTML、Cookie、存储、OCR、查询令牌或完整页面正文带入协调上下文。获得针对当前页面数据和一个具名 Provider 的明确审批后，调用方可在同一路由重新执行并设置 `allowExternalTransfer: true`，只注入该 `runProvider` 一次；Provider 失败时停止并重新请求审批，不能沿用旧审批或自动切换。

续上下文只允许使用仍在本地工作区中的受限工件，并继续遵守单 URL、同源、风险扫描、截断和清理规则。若不再需要续问，应显式清理保留的工作区。

## 清理与返回

使用 `scripts/web-ingest.mjs` 的 `ingestSingleUrlWithLocalContext` 及相关公开导出。调用方不得依赖未公开的原始页面字段；返回只包含 URL 来源、模态、风险/计数摘要、哈希、外传状态和清理状态。除 `NEED_MORE_CONTEXT` 续问外，必须确认临时提示词、视觉附件和工作区已删除。

核心脚本是网站无关的摄取与安全边界；Provider 适配器、选择器、fallback 和登录会话属于组合 Skill 或调用方，不应写入这里。
