# loop-engineer 一键部署管线 —— Cloudflare Pages(**不是 Vercel**)

> 本文档记录 `/deploy` 端点把参赛者作品部署上线的完整机制,以及 2026-07-26 活体测试
> 抓出的三个 Next.js SSR 部署 bug 与修复。写给自己复盘 + 给 codex 对抗性审阅。

## 0. 澄清:我们用的是 Cloudflare,不是 Vercel

**部署目标 100% 是 Cloudflare Pages**(`*.pages.dev`、`npx wrangler pages deploy`、thai-tea CF 账号)。
**没有 Vercel 账号、没有 Vercel 托管、没有 Vercel 计费。**

之所以路径里出现 `.vercel/output/static`,是因为:

1. **Vercel Build Output API** 是一个**开放规范**,产物目录叫 `.vercel/output/`。**更正(codex 指出)**:`next build` 本身只产 `.next`;是 `@cloudflare/next-on-pages`(内部调 `vercel build` / 转换逻辑)把 Next 产物**转换成** `.vercel/output/` 这个 Build Output API 格式。不是 `next build` 直接吐 `.vercel/output`。
2. `@cloudflare/next-on-pages` 是把 Next 产物搬上 CF Pages 的适配器:产出 `.vercel/output/static`(静态资产)+ Pages Functions(把 SSR 逻辑转成 Workers 运行时)。**重要(codex 指出)**:这个 adapter **已被 Cloudflare 标记 deprecated**,官方现推荐 **Workers + OpenNext(`@opennextjs/cloudflare`)**。我们目前仍用它是历史/权宜路径,长期应迁移(见 §5 Q6)。
3. 所以 `.vercel/` 只是「Build Output API 的目录名」,是磁盘上的中间产物,**与 Vercel 这个平台/公司无任何运行时关系**。

一句话:**`.vercel/output` = Build Output API 目录格式(由 adapter 生成);`@cloudflare/next-on-pages` = 把 Next 产物搬到 Cloudflare 的(已废弃的)搬运工;最终跑在 Cloudflare。**

## 1. loop-engineer 是什么(以及为什么要碰这些)

loop-engineer 是**编排器**(orchestrator):plan → code(Claude Code)→ review → push → **deploy**。
`/deploy` 是其中「一键部署」这一步(CC-56):把参赛者作品仓的产物部署到 CF Pages,给个在线 URL,7 天自动删。

它要部署的是 **coder 生成的任意前端应用**。coder(Claude Code)常用 `create-next-app` 生成默认 Next.js —— 而 `create-next-app` 默认是 **SSR**(App Router,服务端渲染),不是纯静态。CF Pages 只能托管「静态资产 + Functions」,所以 Next.js SSR 必须经 next-on-pages 适配成 Functions 才能跑。这就是我们碰 next-on-pages 的唯一原因。

> **设计取舍(待讨论)**:如果强制/引导 coder 生成 `output:'export'` 的静态 Next 或非-Next 静态站(Vite/Astro),就能完全绕开 next-on-pages 这套脆弱链路。见 §5 开放问题。

## 2. 部署管线(`src/deploy.ts`)

```
POST /deploy {clientSlug, projectSlug, repo}
  └─ handleDeploy(server.ts)
       ├─ git clone repo → /tmp/wb-deploy-xxx/repo
       ├─ buildIfNeeded(dir)          ← 探测框架、装依赖、构建、定位产物目录
       └─ deployStaticDir(产物目录)   ← ensureProject + wrangler pages deploy
            → 返回 {appUrl: https://wb-<client>-<project>.pages.dev, ...}
            → 发 W5 deployed 回调
```

### 2.1 buildIfNeeded —— 框架探测与产物定位

| 情况 | 处理 | 产物目录 |
|---|---|---|
| 无 `package.json` / 无 `build` 脚本 | 当纯静态,原样部署 | 原目录 |
| Next.js + `output:'export'` | `next build` | `out/` |
| **Next.js 默认(SSR)** | **`npx @cloudflare/next-on-pages@1.13.16`**(pin) | `.vercel/output/static` |
| 其它框架(Vite/CRA/Astro/Gatsby/Hugo…) | `pm run build` | `out`/`dist`/`build`/`public`(按序探测) |

- **不设 `NODE_ENV=production`**:否则跳过 devDependencies,构建工具(tailwind/postcss/vite/next 插件)找不到 → build 挂(#73 修)。
- **build 跑不可信仓库代码**:走 `sandboxEnv` 白名单,剥离所有 secret(#68/#70 修)。
- `public` 保留在 OUTPUT_DIRS:是 Gatsby/Hugo 的**产物**目录;Next 的 public(资产源)不会误命中,因为 Next 已被 isNext 分支在到达这里前单独处理(#74 修)。

### 2.2 deployStaticDir —— 部署到 CF Pages

```
ensureProject(name, requireCompat)  ← 幂等确保 Pages 项目存在;SSR 才设 nodejs_compat(见 §3.3/§6)
npx wrangler@4.114.0 pages deploy <dir> --project-name=<name> --branch=main --commit-dirty=true
```

- 凭据:`PAGES_CF_TOKEN_THAI_TEA` + `THAI_TEA_CLIENT_ID`,经 env 传子进程,不进 argv、不过 hack5。
- 项目名:`wb-<client>-<project>`,归一化小写字母数字连字符 ≤54。
- 清理:cleanupExpiredPages 只删 `wb-` 前缀 + 7 天前的项目。

## 3. 2026-07-26 活体测试:三个 Next.js SSR bug 与修复

用一个**最小默认 App Router SSR 应用**(`iDoris-ai/wb-nextjs-deploy-test`)反复 `POST /deploy`,逐个抓出:

### 3.1 Bug A —— next-on-pages 装不上(npm ERESOLVE)

- **现象**:`built:true` + buildNote:`npx @cloudflare/next-on-pages@1` 报 `npm error code ERESOLVE unable to resolve dependency tree`(`@cloudflare/workers-types` 版本区间冲突)→ 适配整个失败 → 兜底部署源码目录 → **线上 404**。
- **根因**:容器 npm(10+)默认**强制 peer deps**;next-on-pages@1 自身依赖树在严格解析下 ERESOLVE。本地宽松 npm 不报,容器严格 npm 才暴露。
- **修复**:给该 npx 调用注入 `npm_config_legacy_peer_deps=true`(ERESOLVE 标准解)。
- **验证**:修后 `/deploy` 返回 `built:true` **无 buildNote**(next-on-pages 装上并适配成功,产出 `.vercel/output/static`)。✅

### 3.2 Bug B —— 运行时 503「no nodejs_compat compatibility flag」

- **现象**:适配成功、部署上去了,但访问 URL 运行时 503,页面标题 `Error - no nodejs_compat compatibility flag`。
- **根因**:next-on-pages 出的 SSR Functions 用 `node:*` 内置模块,CF Pages 项目必须开 `nodejs_compat` 兼容标志 + `compatibility_date ≥ 2024-09-23`,否则运行时拒绝。

### 3.3 Bug C(我自己先走错的弯路)—— 怎么设 nodejs_compat

- **错误尝试**:给 `wrangler pages deploy` 加 `--compatibility-flags=nodejs_compat --compatibility-date=…`。
  → wrangler **v4.114** 报 `Unknown arguments: compatibility-flags` —— **这个版本的 `pages deploy` 根本没有 compat CLI 参数**(`--help` 只有 project-name/branch/commit-*/skip-caching/no-bundle/upload-source-maps)。整个部署失败。
- **一度误判**:我以为「wrangler 按部署粒度覆盖项目级 compat」,还去掉了项目级 PATCH —— **是错的**。真相是那几次 `/deploy` 都因 build 慢 + 我 curl 超时而**没跑完**,PATCH 压根没执行,不是被覆盖。
- **正解(活体验证)**:wrangler v4 pages deploy 无 compat 参数,nodejs_compat **只能在项目级** `deployment_configs` 设,Pages direct-upload 的每次部署**继承**项目级配置。
  - API 实测:`PATCH /accounts/{acct}/pages/projects/{name}` body `{"deployment_configs":{"production":{"compatibility_flags":["nodejs_compat"],"compatibility_date":"2025-08-15"},"preview":{...}}}` → `success:True` → `flags:['nodejs_compat']`,且部署后**最新 deployment 确实带 `flags:['nodejs_compat']`**。✅
  - **caveat(codex 指出)**:「PATCH 后 direct-upload 立即继承」是**活体验证过、但官方文档未明确承诺**的行为,且有传播时序;生产上应在部署后复查 deployment 的 flags,不能盲信。
  - 故 `ensureProject`(SSR 路径):**裸建项目 → 无论新老都 PATCH 设 compat → 读回 `result.deployment_configs` 断言 `nodejs_compat` flag + `compatibility_date` 真生效**(新老走同一条已验证机制;`success:true` ≠ 生效)。必须在 wrangler deploy **之前**设,新部署才继承;**PATCH 失败或断言不过即硬失败**(见 §6)。
  - 部署后再做一次**部署级冒烟**(`smokeTestSsr`:轮询 `appUrl`,持续 5xx 才判失败)—— 项目级设对 ≠ 本次 deployment 真起来,冒烟不过不发 deployed(见 §6)。

### 三关串起来(端到端已验证 ✅)

```
装(legacy-peer-deps) → 适配(next-on-pages 产 .vercel/output/static)
  → 项目设 nodejs_compat(ensureProject PATCH) → wrangler deploy(继承 compat)→ SSR 页面 200
```

**活体验证(2026-07-26,`wb-nextjs-deploy-test` 默认 App Router SSR)**:
- 最新部署(03:28)compat:`flags=['nodejs_compat'] date=2024-11-01`(**新部署确实继承了项目级配置**)。
- `curl https://wb-wbtest-nextjs-deploy-test.pages.dev/` → **HTTP 200**,页面含 SSR 渲染的 marker `WB-NEXTONPAGES-OK` / `部署成功` / `Next.js on Cloudflare`。
- 对照:修复前同一 URL 是 404(Bug A)→ 503(Bug B/C)→ 现在 200。

## 4. 为什么整个调试过程这么乱(诚实复盘)

1. **build 慢被误当卡死**:冷容器上 `npm install` + next-on-pages(自带拉 vercel CLI 一大坨 + 跑 next build)要 3–8 分钟;我 curl 超时(500/550s)以为「卡住」,其实服务端还在跑。**教训**:重活要后台发 + 轮询 CF API,别用同步 curl 超时判生死。
2. **单实例容器被自己打爆**:singleton + 我连发多趟 + 每趟服务端不因 curl 断开而中止 → 挤在一个 standard-2 上抢资源。
3. **每改一次就重建镜像 → 冷启**:npm 缓存全丢,更慢。
4. **本地 macOS 复现有坑**:`timeout` 命令不存在(exit 127)、cwd 重置 → 本地迭代失败,更该直接对着 Linux 容器/真 CF 迭代。

## 5. 开放问题(请 codex 挑战)

1. **要不要根本上绕开 SSR**?引导 coder 默认生成 `output:'export'` 静态 Next 或 Vite 静态站 → 免 next-on-pages、免 nodejs_compat、免这一切脆弱性。什么场景才真需要 SSR?
2. **`legacy-peer-deps` 会不会掩盖真实不兼容**、装出跑不起来的产物?有没有更稳的(pin next-on-pages 版本 / 在 Docker 镜像里预装)?
3. **`compatibility_date` 固定 `2024-11-01`** 是否偏旧,会不会缺新运行时特性?用「够新的固定日期」还是「今天」?
4. **nodejs_compat 对纯静态部署**统一开真的零副作用吗?
5. **Next.js 带非-edge 的 API/动态路由**时,next-on-pages 仍会失败 —— 当前兜底是 buildNote + 部署源码目录(404)。是否应改成明确 `built:false` + 不部署坏产物?
6. **ensureProject 的 PATCH 失败只 log.warn 继续** —— 会导致「部署成功但 SSR 503」的静默坏状态,是否该视作硬失败?

## 6. codex 对抗审阅后的加固(2026-07-26)

把复盘文档 + deploy.ts diff 交 codex(Tier1)对抗审阅,采纳并落地的修复:

| codex 发现 | 处理 | 落地 |
|---|---|---|
| **严重1** PATCH 失败只 warn→仍 200+deployed→线上 503 静默坏状态 | ✅ 认 | `ensureProject(requireCompat=true)` 时 PATCH/建项目失败**硬失败抛错**;上层 500、不发 deployed |
| **严重2** next-on-pages 失败/无产物→回退部署源码目录→200 但 404 | ✅ 认 | SSR 适配失败或未产出 `.vercel/output/static` **硬失败抛错**,绝不部署坏产物/谎报 deployed |
| **中3** PATCH 可能覆盖项目 env/bindings | ✅ 认 | 只在 `requireCompat=true`(SSR)才碰 `deployment_configs`;纯静态**完全不 PATCH** |
| **中4** compat_date 2024-11-01 偏旧 | ✅ 认 | 提到 **2025-08-15**(覆盖 process.env≥2025-04-01、node:http/https≥2025-08-15) |
| **中5** `next-on-pages@1`/`wrangler@latest` 浮动 | ✅ 认 | pin **`@cloudflare/next-on-pages@1.13.16`** + **`wrangler@4.114.0`** |
| **中6** legacy-peer-deps 注释太武断 | ✅ 认 | 注释改为「风险可接受的临时绕过」,标注中期应 pin+预装 |
| **轻8** 文档第13行「next build 天然产 .vercel/output」不准确 | ✅ 认 | §0 已更正:next build 只产 .next,adapter 才转成 .vercel/output |
| **轻9** next-on-pages 已 deprecated | ✅ 认 | §0 标注已废弃,官方推 Workers/OpenNext(见下 §7) |
| **中3(深合并)/中7(并发互斥)** | ⚠️ 部分认 | wb-* 是一次性项目、不设 bindings、并发概率低,真实风险≈0;记为**已知限制/后续**,未在本 PR 引入深合并/加锁 |

## 7. 架构方向(codex §5 回应 + 待决)

- **应默认绕开 SSR**:参赛者展示型前端优先引导 coder 生成 `output:'export'` 静态站(免 next-on-pages、免 nodejs_compat、免这一切脆弱性),只有明确需要 SSR/API/Server Actions 才走适配。
- **next-on-pages 已废弃**:长期正确方向是 **Workers + OpenNext(`@opennextjs/cloudflare`)**,但那要重做部署链路、改变「部署到 Pages」的产品假设 —— 需产品决策,不在本 bug-fix PR 范围。
- **本 PR 定位**:让现有 Pages 路径**可靠 + 失败时诚实**(不再谎报 deployed / 上线坏 URL),不做架构迁移。

## 8. ultrareview + codex 二轮加固(2026-07-26)

一轮 ultrareview(R4 阻断)+ 再交 codex 对抗审阅,又采纳落地:

| 发现 | 处理 | 落地 |
|---|---|---|
| **R4 阻断** PATCH `success:true` ≠ flag 真生效 | ✅ 认 | `assertNodejsCompat` 读回 `result.deployment_configs.production` 断言 flag;ensureProject 重构裸建→PATCH→断言(新老同路径,顺带闭合 R2「新建路径未测」) |
| **codex 严重** 只断言项目级 ≠ 本次 deployment 真起来 | ✅ 认 | `smokeTestSsr`:SSR 部署后轮询 appUrl(~28s 上限),持续 5xx 即抛、不发 deployed |
| **codex 中** 只断言 flag 不断言 compatibility_date(旧 date 仍坏) | ✅ 认 | assertNodejsCompat 加 date ≥ 目标值断言 + 补测试 |
| **codex 中** 非-Next build 无产物回退源码目录→404 | ✅ 认 | 改**硬失败抛错**,不再回退部署源码 |
| **codex 轻** 文档与实现不一致(建项目带 configs vs 裸建→PATCH) | ✅ 认 | §3.3 已更正为裸建→PATCH→断言 |
| **codex 中(PLAUSIBLE)** 已存在项目 production_branch 非 main | ⚠️ 记为已知限制 | wb-* 恒以 production_branch:main 新建,外部改动概率≈0;未加额外断言 |

测试:`test-deploy-build.ts` assertNodejsCompat 覆盖 9 例(2 命中含 date + 7 fail-closed 含 date 旧/缺)。
