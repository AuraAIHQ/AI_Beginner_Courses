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

### 持久化边界（生产 = CF Container，容器盘 ephemeral）

配了 `WORKBENCH_STORE_URL` 时（生产默认），数据分两类落 Worker 侧 D1，容器经 `/_store/*` 读写：

| 类别 | 内容 | 落库方式 |
|---|---|---|
| 持久数据模型 | `client.json` / `state.json`（含 usage） | 每次写立即入库，D1 即 source of truth |
| 工作集 | 7 个 `.md` + `conversation.jsonl` | **读写走容器本地盘**（agent-sdk / git 直接操作），另镜像一份备份进 D1：文档每轮末全量快照，会话按 192KB 分块存多个 key + 一个 `conv/count`；容器重启后由 `ensureProjectWorkset()` 从备份写回盘 |

工作集的 source of truth 是**盘**，D1 里那份是备份。恢复协议的几条硬规则：

- **提交点是 `conv/count`**，写序为「先写块、后写 count」。恢复严格按 count 读 0..n-1，任一块缺失或拼出的 JSONL 有坏行 → 整份判不可恢复，**不截断**（把前缀当完整历史 = 把「丢了一半」伪装成恢复成功）。MetaStore 没有 delete，靠 count 变小来覆盖 reset 前的旧残块，避免旧尾巴拼到新会话后面。
- **恢复是先读进内存、判定通过才落盘**，判定失败时盘上一个字节都不落。`conversation.jsonl` 是 present 的判据也是落盘的最后一步 —— 否则半成品会让下一次调用把 `lost` 误判成 `present`，409 静默退化。
- 备份也没有（项目建于本机制上线前、或备份不完整）而 `state.rounds > 0` → `lost`：**绝不铺空模板冒充恢复**，`/api/chat`、`/api/commit` 一律 409；用户显式确认（`acceptWorksetLoss: true`）才继续，此时文档若有备份仍照常恢复真内容（丢的只是会话），凭空重建的空模板顶部带丢失横幅，且该轮无条件不 commit/push。
- **备份是 best-effort，不阻断当轮**：轮内增量备份失败只记日志（轮末全量补写自愈），轮末全量备份失败则先保证 `rounds`/`usage` 落账，再把 `state.worksetBackupDirtyAt` 标脏并在响应里告警 —— 不阻断，但也绝不假装备份还在。
- 单条会话 entry 超过 1MB 时，**备份里**替换为带说明的占位（盘上仍是原文），避免一条超长消息让整个项目从此备份不上。
- 同一项目的 `/api/chat`、`/api/commit` 走进程内 `withProjectLock` 串行（`rounds`/`usage` 是 read-modify-write，并发会丢轮次和漏账）。**这把锁只在单实例部署下成立**；将来横向扩容必须换 Durable Object 或 D1 上的 CAS。

## 下一版路线

- 多模态输入落地：语音转写、PDF/Word/图片解析（v0 已留接口与占位）
- 输出改为「每客户独立 GitHub repo」的可选模式
- 下游 loop 触发：commit 后自动派发一个建系统的 Claude Code loop
- 测试反馈回流：把下游 loop 的测试结果作为新一轮输入自动喂回

架构细节见 [ARCHITECTURE.md](./ARCHITECTURE.md)。
