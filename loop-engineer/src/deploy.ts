/**
 * W4+ — 参赛者「一键部署」到 Cloudflare Pages（CC-54 / a5f82150）。
 *
 * 参赛者点「部署」→ WorkBench 用内置 thai-tea CF 账号把作品仓的静态产物部署到 CF Pages →
 * 返回在线 URL（<name>.pages.dev）→ 发 deployed 回调 → 7 天后自动删（不占资源）。
 *
 * 凭据从本机 env 读（PAGES_CF_TOKEN_THAI_TEA + THAI_TEA_CLIENT_ID，专用于 Pages 部署，
 * 与隧道/DNS 用的账号隔离）；绝不经 hack5 过线。部署走 `npx wrangler pages deploy`（免装）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "./log.js";
import { sandboxEnv } from "./providers.js";

const pexec = promisify(execFile);
const API = "https://api.cloudflare.com/client/v4";
/** 只管理我们建的项目：名字带此前缀，7 天清理也只扫这前缀，绝不误删账号里其它项目。 */
const PROJECT_PREFIX = "wb-";

export interface CfCreds {
  token: string;
  accountId: string;
}

/** 读专用于 Pages 部署的 CF 凭据；未配返回 null（/deploy 则 501 优雅拒绝，不崩）。 */
export function cfCreds(): CfCreds | null {
  const token = process.env.PAGES_CF_TOKEN_THAI_TEA || process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.THAI_TEA_CLIENT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) return null;
  return { token, accountId };
}

/** Pages 项目名：wb-<client>-<project>，归一成 CF 允许的小写字母数字连字符、≤54。 */
export function pagesProjectName(clientSlug: string, projectSlug: string): string {
  const raw = `${PROJECT_PREFIX}${clientSlug}-${projectSlug}`;
  const safe = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return safe.slice(0, 54) || "wb-app";
}

async function cfFetch(
  path: string,
  method: string,
  cf: CfCreds,
  body?: unknown,
): Promise<{ success: boolean; result?: any; errors?: Array<{ code?: number; message?: string }> }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${cf.token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as { success: boolean; result?: any; errors?: any[] };
}

// next-on-pages 出的 Next.js SSR Functions 用 node:* 内置模块,Pages 项目必须开 nodejs_compat +
// 够新的 compatibility_date,否则运行时 503「no nodejs_compat compatibility flag」(活体实测)。
// 关键:wrangler v4 `pages deploy` **没有** compat CLI 参数(--compatibility-flags 报 Unknown arguments),
// 只能走项目级 deployment_configs —— Pages direct-upload 的每次部署继承项目级配置。API PATCH 实测生效
// (success:True → flags:['nodejs_compat'])。对纯静态部署无副作用(无 Functions 用不到)。date 固定
// 2024-11-01(≥2024-09-23 才启用 nodejs_compat)保证可复现。
const COMPAT = { compatibility_date: "2024-11-01", compatibility_flags: ["nodejs_compat"] };
const DEPLOYMENT_CONFIGS = { production: COMPAT, preview: COMPAT };

/**
 * 确保 Pages 项目存在且已开 nodejs_compat（幂等）。
 * 无则建（带 compat）；有则 PATCH 补齐(覆盖历史遗留没开标志的老项目)。必须在 deploy 前设,
 * 新部署才继承。PATCH 失败不致命(记日志继续,静态站不受影响)。
 */
async function ensureProject(name: string, cf: CfCreds): Promise<void> {
  const got = await cfFetch(`/accounts/${cf.accountId}/pages/projects/${name}`, "GET", cf);
  if (got.success) {
    const patched = await cfFetch(`/accounts/${cf.accountId}/pages/projects/${name}`, "PATCH", cf, {
      deployment_configs: DEPLOYMENT_CONFIGS,
    });
    if (!patched.success) log.warn(`Pages 项目 nodejs_compat 补齐失败(继续部署)：${JSON.stringify(patched.errors)}`);
    return;
  }
  const created = await cfFetch(`/accounts/${cf.accountId}/pages/projects`, "POST", cf, {
    name,
    production_branch: "main",
    deployment_configs: DEPLOYMENT_CONFIGS,
  });
  if (!created.success) {
    throw new Error(`建 Pages 项目失败：${JSON.stringify(created.errors)}`);
  }
}

export interface DeployResult {
  appUrl: string;
  projectName: string;
  /** 我方托管的到期时间（ISO）；到期后 cleanup 会删。 */
  expiresAt: string;
  /** 自部署教程（让参赛者用自己的 CF 账号长期托管）。 */
  selfDeployHint: string;
}

const SELF_DEPLOY_HINT =
  "想长期托管到你自己的账号：① 注册 Cloudflare（免费）→ Workers & Pages → Create → Pages；" +
  "② 连上这个 GitHub 仓（main 分支）自动构建部署，或本机装 wrangler 后在仓目录跑 " +
  "`npx wrangler pages deploy . --project-name=<你起的名>`。我方这份托管 7 天后自动删除。";

// 常见静态产物目录(按站点优先级);非-Next 框架 build 后在此列表里找可部署目录。
// .vercel/output/static = @cloudflare/next-on-pages 适配产物;out = Next `output:export`;dist = Vite/Astro;build = CRA。
// `public` = Gatsby / Hugo / Eleventy 的**构建产物**目录(它们就把成品写进 public/)—— 必须保留。
// 唯一坑是 Next.js:它的 public/ 是静态资产源(favicon 等)不是产物,误部署会得 404。但 Next 已被
// 上面的 isNext 分支在到达本列表前单独处理(next-on-pages / out),永不落到这里 —— 故对 Next 无回归,
// 对 Gatsby/Hugo 反而不能少 public(pr-daemon #74 review)。
const OUTPUT_DIRS = ["out", "dist", "build", ".vercel/output/static", "public"];

async function pathExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

/** 在 dir 下按优先级找可部署的静态产物目录;都不存在返回 null。导出供测试。 */
export async function findDeployableOutput(dir: string): Promise<string | null> {
  for (const d of OUTPUT_DIRS) {
    if (await pathExists(path.join(dir, d))) return path.join(dir, d);
  }
  return null;
}

/** 探测包管理器(按 lockfile);默认 npm。 */
async function detectPackageManager(dir: string): Promise<"pnpm" | "yarn" | "npm"> {
  if (await pathExists(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(path.join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * 探测 Next.js 是否配了 `output: 'export'`(纯静态导出 → `next build` 直接产 out/,无需 next-on-pages)。
 * 轻量正则扫 next.config.*(不执行),匹配不到就按默认 SSR 处理(交给 next-on-pages)。
 * 目的(pr-daemon #74 建议):export 模式省掉 ~8min next-on-pages 适配,而**不**给常见 SSR 应用
 * 引入「next build + next-on-pages 内部再 build」的双重构建。
 */
async function nextIsStaticExport(dir: string): Promise<boolean> {
  for (const f of ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"]) {
    try {
      const src = await fs.readFile(path.join(dir, f), "utf8");
      if (/output\s*:\s*['"`]export['"`]/.test(src)) return true;
    } catch {
      /* 文件不存在 → 试下一个 */
    }
  }
  return false;
}

export interface BuildOutcome {
  /** 最终要部署的目录(build 产物,或纯静态时的原目录)。 */
  deployDir: string;
  built: boolean;
  /** 给用户的提示(如 Next.js SSR 未产出静态目录)。 */
  note?: string;
}

/**
 * 部署前构建:若是前端框架项目(package.json 有 build 脚本)→ 装依赖 + build → 返回构建产物目录;
 * 纯静态(无 package.json / 无 build 脚本)→ 原目录直接部署(现状行为)。
 *
 * ⚠️ 会在容器内跑克隆仓库的 install/build 脚本(执行不可信代码)—— 与 coder(claude -p 同容器跑作品代码)
 * 同一信任模型;后续可隔离到独立 sandbox。带超时(各 5min),失败抛错由调用方兜成 500。
 */
export async function buildIfNeeded(dir: string): Promise<BuildOutcome> {
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null = null;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    return { deployDir: dir, built: false }; // 无 package.json → 纯静态,原样部署
  }
  if (!pkg?.scripts?.build) return { deployDir: dir, built: false }; // 无 build 脚本 → 当作静态

  const pm = await detectPackageManager(dir);
  // 安全(pr-daemon #68 review):build 脚本是不可信仓库代码,绝不能拿到 host secret。
  // 走 coder 同款 sandboxEnv 白名单 —— 只放行 PATH/HOME/locale 等,剥离所有 *_API_KEY/*_TOKEN/
  // *_SECRET(WORKBENCH_CALLBACK_SECRET / CF token / push token / DEEPSEEK key 等),杜绝外泄。
  // 构建所需的非机密变量作为 extra 并入。
  // 不设 NODE_ENV=production:它会让 npm/pnpm/yarn 跳过 devDependencies,而构建工具
  // (tailwindcss/postcss、typescript、vite、next 插件…)恰恰在 devDeps → build 会
  // 「Cannot find module」挂掉(flight-monitor 实测)。next/vite build 本就产生产物,不需要它。
  const env = sandboxEnv(process.env, { CI: "1", GIT_TERMINAL_PROMPT: "0", NEXT_TELEMETRY_DISABLED: "1" });
  const opts = { cwd: dir, env, maxBuffer: 16 * 1024 * 1024, timeout: 300_000 } as const;
  // --include=dev / --prod=false:双保险确保 devDeps(构建工具)装上,即便环境残留 NODE_ENV=production。
  const installArgs =
    pm === "npm"
      ? ["install", "--no-audit", "--no-fund", "--include=dev"]
      : pm === "pnpm"
        ? ["install", "--no-frozen-lockfile", "--prod=false"]
        : ["install", "--production=false"];
  log.step(`部署前构建(${pm}):${dir}`);
  await pexec(pm, installArgs, opts);

  // Next.js 分两条路:① output:'export' 静态导出 → `next build` 直接产 out/,直接部署;
  // ② 默认 SSR/hybrid → `next build` 只产 .next(CF Pages 部署不了)→ 官方 @cloudflare/next-on-pages
  // 适配成兼容产物(.vercel/output/static + Functions,它内部自跑 next build,故 SSR 路不另跑 run build)。
  // 适配失败(常见:动态/API 路由未声明 edge runtime)→ 回退给可读 note,不强行部署坏产物。
  const isNext = !!(pkg.dependencies?.next || pkg.devDependencies?.next);
  if (isNext) {
    // 先看是否 output:'export'(静态导出)—— 是则普通 `next build` 就产 out/,直接部署,
    // 省掉后面 ~8min 的 next-on-pages 适配。只认 out/(export 产物),不碰 public/(资产源)。
    if (await nextIsStaticExport(dir)) {
      log.step("Next.js output:export → next build → out/");
      await pexec(pm, ["run", "build"], opts);
      const outDir = path.join(dir, "out");
      if (await pathExists(outDir)) {
        log.ok("Next.js 静态导出产物:out/");
        return { deployDir: outDir, built: true };
      }
      log.warn("声明 output:export 但未产出 out/,回退 next-on-pages 适配");
    }
    // 默认 SSR/hybrid(只产 .next,CF Pages 部署不了)→ next-on-pages 适配成兼容产物。
    // npm_config_legacy_peer_deps:容器 npm(10+)默认强制 peer deps,而 next-on-pages@1 自身依赖树
    // (含 @cloudflare/workers-types 版本区间)在严格解析下报 ERESOLVE「unable to resolve dependency tree」
    // → npx 装不上、适配整个失败(wb-nextjs-deploy-test 活体实测)。legacy-peer-deps 是 ERESOLVE 的标准解:
    // 放宽 peer 约束、按最近满足版本装,不影响适配产物正确性。本地宽松 npm 不报、容器严格 npm 才暴露。
    try {
      log.step("Next.js SSR → @cloudflare/next-on-pages 适配 CF Pages");
      await pexec("npx", ["--yes", "@cloudflare/next-on-pages@1"], {
        ...opts,
        env: { ...env, npm_config_legacy_peer_deps: "true" },
        timeout: 480_000,
      });
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      log.warn(`next-on-pages 适配失败:${msg}`);
      return {
        deployDir: dir,
        built: true,
        note:
          "Next.js 应用需 @cloudflare/next-on-pages 适配才能上 CF Pages,本次适配失败" +
          "(常见:动态路由 / API 路由需声明 `export const runtime = 'edge'`,或改用 next.config 的 " +
          `output:'export' 静态导出)。适配报错:${msg}`,
      };
    }
    const nopOut = path.join(dir, ".vercel", "output", "static");
    if (await pathExists(nopOut)) {
      log.ok("Next.js 适配产物:.vercel/output/static");
      return { deployDir: nopOut, built: true };
    }
    return { deployDir: dir, built: true, note: "next-on-pages 未产出 .vercel/output/static,回退部署源码目录(可能不可用)。" };
  }

  await pexec(pm, ["run", "build"], opts);
  const found = await findDeployableOutput(dir);
  if (found) {
    log.ok(`构建产物目录:${path.relative(dir, found)}`);
    return { deployDir: found, built: true };
  }
  // 非-Next 框架:build 完成但没找到 out/dist/build 静态产物 → 回退部署源码目录 + 提示。
  const note = "build 完成但未找到 out/dist/build 等静态产物目录,回退部署源码目录(可能不可用)。";
  log.warn(note);
  return { deployDir: dir, built: true, note };
}

/**
 * 把一个静态目录部署到 CF Pages，返回生产 URL（<name>.pages.dev，稳定别名）。
 * 走 npx wrangler pages deploy；token/account 经 env 传给子进程，不进 argv。
 */
export async function deployStaticDir(
  dir: string,
  clientSlug: string,
  projectSlug: string,
  cf: CfCreds,
  retentionDays = 7,
): Promise<DeployResult> {
  const name = pagesProjectName(clientSlug, projectSlug);
  await ensureProject(name, cf);
  const env = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: cf.token,
    CLOUDFLARE_ACCOUNT_ID: cf.accountId,
    GIT_TERMINAL_PROMPT: "0",
  };
  log.step(`部署到 CF Pages：${name}（${dir}）`);
  // nodejs_compat 由 ensureProject 在项目级设(deployment_configs),此次部署继承 —— wrangler v4
  // pages deploy 没有 compat CLI 参数(见 ensureProject 注释),不能在这里传。
  await pexec(
    "npx",
    [
      "--yes",
      "wrangler@latest",
      "pages",
      "deploy",
      dir,
      `--project-name=${name}`,
      "--branch=main",
      "--commit-dirty=true",
    ],
    { env, maxBuffer: 16 * 1024 * 1024, timeout: 180_000 },
  );
  const appUrl = `https://${name}.pages.dev`;
  const expiresAt = new Date(Date.now() + retentionDays * 86400 * 1000).toISOString();
  log.ok(`已部署：${appUrl}（${retentionDays} 天后自动删）`);
  return { appUrl, projectName: name, expiresAt, selfDeployHint: SELF_DEPLOY_HINT };
}

/** 清理 N 天前我方建的 wb-* Pages 项目（尽力而为，只删本前缀 + 过期）。 */
export async function cleanupExpiredPages(maxAgeDays = 7): Promise<{ deleted: string[] }> {
  const cf = cfCreds();
  if (!cf) return { deleted: [] };
  const list = await cfFetch(`/accounts/${cf.accountId}/pages/projects?per_page=100`, "GET", cf);
  if (!list.success) return { deleted: [] };
  const cutoff = Date.now() - maxAgeDays * 86400 * 1000;
  const deleted: string[] = [];
  for (const p of (list.result ?? []) as Array<{ name: string; created_on: string }>) {
    if (!p.name.startsWith(PROJECT_PREFIX)) continue; // 只碰我方建的
    const created = new Date(p.created_on).getTime();
    if (Number.isFinite(created) && created < cutoff) {
      const del = await cfFetch(`/accounts/${cf.accountId}/pages/projects/${p.name}`, "DELETE", cf);
      if (del.success) deleted.push(p.name);
    }
  }
  if (deleted.length) log.ok(`清理过期 Pages 项目 ${deleted.length} 个：${deleted.join(", ")}`);
  return { deleted };
}
