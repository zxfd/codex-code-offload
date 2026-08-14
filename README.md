# Codex Code Offload

面向 Codex Desktop 的「token 优先」代码/日志/文档/OCR/图片推理卸载网关。它把大型源码、提取文本、
日志或少量页面图打包后，交给**已登录的网页版大模型**（ChatGPT / DeepSeek / Qwen / Gemini）做只读
推理，再把结构化短结论交回 Codex 本地核验、修改与测试。Web 大模型只负责分析，不拥有执行权限。

## 架构

```text
Codex Desktop
  -> 全局 AGENTS.md 路由判断（可选）
  -> agentchat-code-offload Skill（本仓库 skill/）
  -> codex-agentchat-offload Adapter（本仓库 adapter/，调用 repomix 打包）
  -> 临时 BROWSER_PROMPT_FILE + OFFLOAD_REQUEST_FILE
  -> web-provider-runner（本仓库 skill/scripts/）
  -> ChatGPT / DeepSeek / Qwen / Gemini 网页 Provider
  -> 结构化短回答 -> Codex 本地核验、修改、测试
```

命名沿用了历史上的「AgentChat」，但当前实现直接驱动网页 Provider，不再经过独立的 AgentChat 平台。

## 安装前要求

- macOS / Linux（文档分析用到 macOS `textutil`，PDF 用到 `pdftotext`）
- Node.js 与 npm
- `rg`（ripgrep，用于 symbol/文本搜索）
- `pdftotext`（poppler，仅 PDF 文档分析需要；缺失时其余功能仍可用）
- 一个 Codex 可驱动的浏览器，并已登录上述网页大模型（见下文“浏览器登录”）

## 一键安装

```sh
git clone https://github.com/zxfd/codex-code-offload.git
cd codex-code-offload
./install.sh
```

`install.sh` 会把：

- `skill/` 软链到 `~/.codex/skills/agentchat-code-offload/`
- `skills/luna-model-routing/` 软链到 `~/.agents/skills/luna-model-routing/`
- `skills/repo-execution/` 软链到 `~/.agents/skills/repo-execution/`
- `adapter/` 软链到 `~/.local/share/codex-code-offload/`（可用 `CODEX_CODE_OFFLOAD_HOME` 覆盖）
- 创建状态目录 `~/.local/state/codex-web-reasoning/`
- 在 adapter 目录执行 `npm install` 安装 `repomix`

所有源码路径均基于 `$HOME` 计算，不依赖本机用户名；换一台机器克隆后直接 `./install.sh` 即可。

## 浏览器登录（一次性、手动）

卸载网关复用你浏览器里已经登录的网页会话，**不使用 API key**。首次使用前，在同一浏览器里登录：

- ChatGPT：https://chatgpt.com/
- DeepSeek：https://chat.deepseek.com/（并使用“专家模式”）
- Qwen：https://chat.qwen.ai/
- Gemini：https://gemini.google.com/app

Codex 通过浏览器自动化驱动这些页面。登录状态、模型/强度选择与可见附件确认都由 Skill 内部校验。

## 启用自动路由（可选）

把 `config/agents-md-offload-block.md` 中的片段合并到你的全局 `AGENTS.md`，Codex 就会在大型分析任务
上默认走本网关；不合并时仍可手动按 `skill/SKILL.md` 调用。

## 目录结构

```text
skill/     Codex Skill（SKILL.md + 浏览器自动化脚本）
skills/    协作型路由 Skill 与稳定仓库执行规范
adapter/   本地打包与安全边界 Adapter（codex-agentchat-offload.mjs + providers.json）
config/    全局 AGENTS.md 路由片段
install.sh  一键安装（软链 + npm install）
uninstall.sh 卸载（仅移除软链与状态目录，不改动仓库文件）

## ChatGPT 响应确认

ChatGPT 的发送和回答确认是同一个请求闭环：adapter 会记录发送前 assistant 消息数量，只接受发送后新增的 assistant 消息，并等待该消息稳定完成。发送按钮出现超时等“结果不确定”的情况会继续观察同一请求，绝不盲目重复发送；发送后的异常也不会写入负面健康缓存，避免一次浏览器状态抖动导致后续请求直接 fallback。回归测试可运行：

```sh
node --test skill/scripts/tests/chatgpt-response-confirmation.test.mjs
```

## 终局会话清理

每轮 Web-LLM 对话在确认终局回答后，才由对应 Provider Adapter 清理会话，然后关闭 Chrome 标签；`NEED_MORE_CONTEXT` 续聊不会提前清理。ChatGPT 使用“更多 → 归档”，不刷新页面并确认归档菜单关闭；归档失败时保留标签供恢复。

Qwen 采用“会话行菜单 → 归档”，并且只在“归档”成功确认后关闭标签；归档动作会被视为首选清理路径，失败会保留标签供后续恢复。

DeepSeek 当前真实页面没有归档项，固定使用“会话行菜单 → 删除 → 删除该对话”，确认当前会话链接已从侧栏消失后才关闭标签。删除是不可恢复操作，只有 DeepSeek 的显式清理策略会执行它。

Gemini 现已固化为“会话行菜单 → 删除 → 删除”清理，菜单名称为“打开对话操作菜单。”；删除确认弹窗标题为“要删除对话吗？”，按钮为“删除”。清理前要求当前 URL 为 Gemini 会话页；清理时不刷新页面，确认会话层级已移除或 URL 变化后才允许 Runner 关闭标签。`providers.json` 已将 `gemini-current.target.conversation_cleanup` 固定为 `delete`。

DeepSeek 每次发送前还会确认“专家模式”和“深度思考”均已开启；任一控件无法确认，当前 Provider 失败并按既定路由继续。调用 runner 时必须传入 `browserChannel: "chrome"`。

开启深度思考后，Adapter 会自动延长回答等待预算：350K 保留输出配置最长等待 420 秒，其他深度思考请求至少等待 300 秒，并继续以“停止回答”控件判断是否仍在生成。

## 安全边界（摘要）

- Adapter 拒绝敏感路径、glob、仓库外路径与明显的凭证文本；只打包用户显式选择的仓库内文件。
- PDF/DOCX/RTF 先本地提取为有界文本，再扫描凭证后发送，原始二进制不离开本机。
- Web 大模型的回答一律视为**未经验证的假设**，Codex 负责本地核验、修改与测试。
- 不读取或输出 Cookie、登录数据库、token、密钥和无关私密会话。

## 卸载

```sh
./uninstall.sh
```

只会移除 `~/.codex/skills/agentchat-code-offload`、`~/.local/share/codex-code-offload` 两个软链和状态
目录，仓库文件本身保留。
