# loop-engineer 一键部署管线 —— Cloudflare Pages(**不是 Vercel**)

> 本文档记录 `/deploy` 端点把参赛者作品部署上线的完整机制,以及 2026-07-26 活体测试
> 抓出的三个 Next.js SSR 部署 bug 与修复。写给自己复盘 + 给 codex 对抗性审阅。

## 0. 澄清:我们用的是 Cloudflare,不是 Vercel

**部署目标 100% 是 Cloudflare Pages**(`*.pages.dev`、`npx wrangler pages deploy`、thai-tea CF 账号)。
**没有 Vercel 账号、没有 Vercel 托管、没有 Vercel 计费。**

之所以路径里出现 `.vercel/output/static`,是因为:

1. Next.js 的官方构建产物用的是 **Vercel Build Output API**(一个**开放规范**,目录名就叫 `.vercel/output/`)——Next.js 是 Vercel 家的框架,`next build` 天然按这个格式吐产物。
2. `@cloudflare/next-on-pages` 是 **Cloudflare 官方**适配器:它内部跑 `next build` 拿到 `.vercel/output/`,再把其中的 SSR 逻辑**转译成 Cloudflare Pages Functions**(Workers 运行时),静态资产落到 `.vercel/output/static`。
3. 所以 `.vercel/` 只是「Next.js 标准构建产物的目录名」,是磁盘上的中间产物,**与 Vercel 这个平台/公司无任何运行时关系**。

一句话:**`.vercel/output` = Next.js 的构建产物格式;`@cloudflare/next-on-pages` = 把它搬到 Cloudflare 的搬运工;最终跑在 Cloudflare。**

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
| **Next.js 默认(SSR)** | **`npx @cloudflare/next-on-pages@1`** | `.vercel/output/static` |
| 其它框架(Vite/CRA/Astro/Gatsby/Hugo…) | `pm run build` | `out`/`dist`/`build`/`public`(按序探测) |

- **不设 `NODE_ENV=production`**:否则跳过 devDependencies,构建工具(tailwind/postcss/vite/next 插件)找不到 → build 挂(#73 修)。
- **build 跑不可信仓库代码**:走 `sandboxEnv` 白名单,剥离所有 secret(#68/#70 修)。
- `public` 保留在 OUTPUT_DIRS:是 Gatsby/Hugo 的**产物**目录;Next 的 public(资产源)不会误命中,因为 Next 已被 isNext 分支在到达这里前单独处理(#74 修)。

### 2.2 deployStaticDir —— 部署到 CF Pages

```
ensureProject(name)     ← 幂等确保 Pages 项目存在 + 设 nodejs_compat(见 §3.3)
npx wrangler@latest pages deploy <dir> --project-name=<name> --branch=main --commit-dirty=true
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
  - API 实测:`PATCH /accounts/{acct}/pages/projects/{name}` body `{"deployment_configs":{"production":{"compatibility_flags":["nodejs_compat"],"compatibility_date":"2024-11-01"},"preview":{...}}}` → `success:True` → `flags:['nodejs_compat']`。✅
  - 故 `ensureProject`:建项目时带 `deployment_configs`;老项目 PATCH 补齐。必须在 wrangler deploy **之前**设,新部署才继承。

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
