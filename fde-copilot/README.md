# FDE Copilot

> 客户售前 / 持续测试的多模态对话 → **loop-ready spec** 生成器
> 子项目属于 `Self-FDE-WorkBench`，用 Claude Agent SDK（复用你的 Claude 订阅，零 API key）。

## 它解决什么

把客户零散、口语化、不完整的诉求，持续转成一套**下游 Claude Code loop 完全接触不到客户本人也能照着开工**的规格文档。每一轮客户输入都会：

1. 融合进 6 类文档（Spec / Product / Features / Tech Spec / Interactions / Gaps）
2. 自动检测缺口 —— **能查的 AI 自己调研，只有客户知道的抛问题让客户确认**
3. 给出 readiness 就绪度，够格了就标 `loop-ready`
4. 一键（或自动）commit 到本 repo 的 `clients/<客户>/`，供下游 loop 消费

闭环：`初始化 → 持续对话（补缺口+调研+确认）→ 生成 spec → commit → 喂下游 loop → 边测边反馈 → 再循环`。

## 快速开始

```bash
cd fde-copilot
pnpm install
cp .env.example .env        # 本机已 `claude login` 的话，什么都不用填
pnpm dev                    # http://localhost:3939
```

打开页面 → 左栏建一个客户 → 中间说你的情况和诉求 → 右栏看规格实时生成 → 满意后 commit。

### 模型 Provider

每个项目可在网页右栏独立选择模型后端：

- `Claude`：Claude Agent SDK，支持浏览器订阅登录与内建 WebSearch。
- `LM Studio`：OpenAI-compatible 本地模型，通过受控的规格文件工具工作；不会访问项目目录外的文件，也不会声称已联网搜索。

本机开发默认连接 `http://127.0.0.1:1234/v1`；Docker 默认连接 `http://host.docker.internal:1234/v1`。启动 LM Studio Local Server 并加载支持工具调用的模型后，刷新页面即可看到模型列表。

## Docker 部署（Claude 浏览器登录）

容器使用 Claude 订阅登录态，不需要 `ANTHROPIC_API_KEY`。首次登录会在终端显示授权链接；在宿主机浏览器完成登录后，凭证会保存到 Docker 命名卷，重建容器后仍会保留：

```bash
cd fde-copilot
docker compose up --build -d
docker compose exec fde-copilot claude auth login --claudeai
```

访问 `http://localhost:3939`。可用 `docker compose exec fde-copilot claude auth status` 检查登录状态。客户规格与会话状态会持久化在宿主机的 `clients/`；改端口可执行 `FDE_COPILOT_PORT=8080 docker compose up -d`。

如果要公网暴露，请在反向代理层做 HTTPS 与认证。`WORKBENCH_TOKEN` 会要求每个 API 请求包含 `x-workbench-token`，当前网页不会自动附带该 header，因此不要只靠设置这个变量来保护公网入口。

## 安全模型

客户输入原样进 prompt，故对 prompt injection 做了硬性约束（不靠"cwd 看起来隔离"）：

- **工具白名单 + 路径闸**：agent 不再 `bypassPermissions`（`permissionMode: default`）。关键细节——文件/搜索工具**不放进 `allowedTools`**（放进去会被免问放行、绕过校验），只免问放行 `WebSearch` 与自有 MCP 工具；于是 Read/Write/Edit/Glob/Grep 每次都落到 `canUseTool` 校验路径**必须在客户目录内**，越界（绝对路径 / `..`）一律拒绝；`Bash`/`WebFetch` 等默认拒绝（防 SSRF/命令执行）。已实测 `canUseTool` 对每次 Write/Read 触发、Bash 被拒。
- **API 鉴权**：设 `WORKBENCH_TOKEN` 后所有 API 需带 `x-workbench-token` 匹配头；不设则仅本机用，`dev`/`start` 默认 `bind 127.0.0.1`。**公网/无人值守部署务必设 token 或前置鉴权代理。**
- **路径穿越防护**：`clientDir` 校验 slug 不含分隔符/上跳且解析后落在 `clients/` 内；附件名只取 basename。

## 认证

- **本地自用**：机器已 `claude login`（Pro/Max 订阅）即可，SDK 复用订阅，**无需 API key**。
- **无人值守服务器**：在该机器 `claude login`，或在 `.env` 填 `ANTHROPIC_API_KEY`。

## 关键环境变量（`.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 空 | 留空则用订阅认证 |
| `CLAUDE_MODEL` | 空 | 留空跟随 Claude Code 默认 |
| `FDE_DEFAULT_PROVIDER` | `claude` | 新项目默认 Provider：`claude` / `lmstudio` |
| `LMSTUDIO_BASE_URL` | `http://127.0.0.1:1234/v1` | LM Studio OpenAI-compatible 地址 |
| `LMSTUDIO_MODEL` | 空 | 未在项目中指定时使用的本地模型 |
| `LMSTUDIO_API_KEY` | 空 | LM Studio 开启 API Token 时填写 |
| `AGENT_MAX_TURNS` | 40 | 每轮 agent 内部最大 turn 数 |
| `AUTO_COMMIT` | false | 每轮自动 commit 客户目录 |
| `AUTO_PUSH` | false | 自动 commit 时是否 push |

## 客户目录长什么样

```
clients/<slug>/
  SPEC.md          需求规格
  PRODUCT.md       产品描述
  FEATURES.md      feature 细节（用户故事+验收+优先级）
  TECH_SPEC.md     技术方案
  INTERACTIONS.md  逐步交互 + 检查/验收标准
  GAPS.md          缺口台账（待客户回答 / 调研假设待确认 / 已关闭）
  INTAKE.md        客户原话累积记录
  state.json       进度与就绪度（.gitignore，不入库）
  conversation.jsonl  会话日志（.gitignore，不入库）
```

前 7 个 `.md` 入库，就是喂给下游 loop 的 loop-ready 输入。

## 下一版路线

- 多模态输入落地：语音转写、PDF/Word/图片解析（v0 已留接口与占位）
- 输出改为「每客户独立 GitHub repo」的可选模式
- 下游 loop 触发：commit 后自动派发一个建系统的 Claude Code loop
- 测试反馈回流：把下游 loop 的测试结果作为新一轮输入自动喂回

架构细节见 [ARCHITECTURE.md](./ARCHITECTURE.md)。
