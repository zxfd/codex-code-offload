---
name: web-ingest
description: 通用单 URL 页面本地提取与临时暂存 Skill。默认只在受控 Chrome 中提取有界文本和视觉信号、执行同源与隐私风险检查并写入受限临时文件；由调用方决定后续通过 thread、web-llm 或其他方式读取，读取后应及时清理临时文件。
---

# 通用页面提取与暂存

## 工作边界

仅处理一个明确的 `http` 或 `https` URL。默认行为是“提取并暂存”，不选择 Provider、不调用 Provider、不向外部传输页面内容。调用方可以在取得临时文件路径后，自行决定是否通过 thread、web-llm 或其他受控方式读取；读取完成后必须及时调用清理功能。

默认策略为：

```js
{ allowText: true, allowVisual: true, maxImages: 4 }
```

不接受多个 URL、通配符、分隔符拼接或跨来源重定向。

## 三个公开功能

核心脚本是 `scripts/web-ingest.mjs`，公开提供：

1. `extractAndStageSingleUrl(options)`：提取单个 URL 并暂存结果。
2. `readStagedIngestResult(temporaryFilePath)`：读取指定的暂存结果。
3. `cleanupStagedIngestResult(temporaryFilePath)`：删除指定暂存结果及其视觉附件。

`ingestSingleUrlWithLocalContext` 仅作为历史兼容别名，行为等同于第一个功能；它不再执行 Provider 外传。

## 功能一：提取并暂存

完整流程为：

```text
输入单个 URL
  ↓
健康检查
  ↓
URL 与受控 Chrome 约束校验
  ↓
受控 Chrome 打开页面
  ↓
同源重定向校验
  ↓
本地提取可见文本与视觉信号
  ↓
文本隐私扫描 + 视觉风险扫描
  ↓
暂存受限结果和视觉附件
  ↓
判断 text / multimodal 模式
  ↓
返回摘要及临时文件路径
```

健康检查失败时立即停止，不打开页面。

页面提取只读取有界可见信号，不暂存 Cookie、HTML、完整 DOM、浏览器存储、查询令牌或完整页面原文。文本最多暂存约 6,000 个字符；视觉区域最多 4 个。

临时目录结构为：

```text
codex-web-ingest-xxxxxx/
├── result.json
├── visual-01.png
└── visual-02.png
```

`result.json` 保存来源、模式、计数、哈希、风险摘要、受限文本摘录、视觉区域和视觉附件路径。实际视觉内容以权限为 `0600` 的图片文件保存；临时目录权限为 `0700`。

文本凭证或登录提示风险为高时阻断并不生成暂存结果。个人信息信号和视觉风险会写入风险摘要，由调用方在决定读取或外传前自行判断。

成功返回 `status: "staged"` 和 `temporaryFilePath`。阻断返回 `status: "blocked"`；浏览器、路径或提取失败返回 `status: "failed"`。

## 功能二：读取结果

调用方使用 `readStagedIngestResult(temporaryFilePath)` 读取暂存的 `result.json`。

读取功能会：

- 要求绝对路径；
- 要求路径位于系统临时目录下由本 Skill 创建的目录；
- 拒绝路径穿越、符号链接和非普通文件；
- 校验暂存结果的 schema 和模式字段；
- 只返回受限暂存数据，不重新打开网页。

读取结果后，调用方应尽快执行功能三。若要交给 thread 或 web-llm，应只传递当前任务必要的 JSON 字段和视觉附件，不扩大文件范围。

## 功能三：清理临时文件

调用方使用 `cleanupStagedIngestResult(temporaryFilePath)` 删除对应的临时目录，包括 `result.json` 和受限视觉附件。

清理功能会再次校验路径、普通文件类型和目录内容；发现目录中存在未知文件时 fail-closed，不递归删除。返回 `temporaryFileRemoved` 供调用方确认清理状态。

除非明确还要续用结果，否则不得长期保留临时文件。这个 Skill 不负责决定 thread、web-llm 或其他读取器，也不负责 Provider fallback、登录会话或网站专用选择器。
