import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "./log.js";

const pexec = promisify(execFile);

// git 子进程一律非交互：缺凭据/需确认时立即失败，绝不阻塞在终端提示上（clone/fetch/push 都走这条）。
//
// CC-61 容器回归修复：CF Container(root) 里没有全局 git identity，coder 的 `git commit`/`merge --no-ff`
// 会以 `Author identity unknown / root@cloudchamber.(none)` 失败。用 GIT_AUTHOR_*/GIT_COMMITTER_* 环境
// 变量注入一个 bot 身份，覆盖所有产生提交的 git 命令（无需逐调用点改，也不依赖容器全局配置）。
// 已在真实 env 里设了就尊重现有值（LOOP_GIT_AUTHOR_NAME/EMAIL 可覆盖默认）。
const GIT_IDENTITY_NAME = process.env.LOOP_GIT_AUTHOR_NAME || "loop-engineer";
const GIT_IDENTITY_EMAIL = process.env.LOOP_GIT_AUTHOR_EMAIL || "loop-engineer@aastar.io";
const GIT_EXEC_OPTS = {
  maxBuffer: 16 * 1024 * 1024,
  env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || GIT_IDENTITY_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || GIT_IDENTITY_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || GIT_IDENTITY_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || GIT_IDENTITY_EMAIL,
  },
} as const;

async function git(repo: string, args: string[], extraEnv?: Record<string, string>): Promise<string> {
  const { stdout } = await pexec("git", ["-C", repo, ...args], {
    ...GIT_EXEC_OPTS,
    env: { ...GIT_EXEC_OPTS.env, ...extraEnv },
  });
  return stdout.trim();
}

async function tryGit(repo: string, args: string[], extraEnv?: Record<string, string>): Promise<string | null> {
  try {
    return await git(repo, args, extraEnv);
  } catch {
    return null;
  }
}

function safeBranch(b: string): string {
  return b.replace(/[^a-zA-Z0-9._-]/g, "__");
}

/** 存放本引擎所有 worktree 的目录（在目标 repo 隔壁，不污染其工作树） */
function wtRoot(repo: string): string {
  return path.join(path.dirname(path.resolve(repo)), ".loop-wt", path.basename(repo));
}

export async function isGitRepo(repo: string): Promise<boolean> {
  return (await tryGit(repo, ["rev-parse", "--is-inside-work-tree"])) === "true";
}

/** 远程 repo（需 clone）：http(s)/git/ssh scheme，或 scp-like `git@host:path`。本地路径返回 false。 */
export function isRemoteRepo(repo: string): boolean {
  return /^(https?|ssh|git):\/\//i.test(repo) || /^[^\s/]+@[^\s/]+:/.test(repo);
}

/** 允许注入 push token 的 host 白名单（默认 github.com；LOOP_ALLOWED_PUSH_HOSTS 逗号分隔可扩展）。 */
function allowedPushHosts(): string[] {
  const raw = process.env.LOOP_ALLOWED_PUSH_HOSTS;
  return (raw ? raw.split(",") : ["github.com"]).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * 注入 token / clone 远程仓前的 host 白名单校验（纵深防护：disk-watch 扫到的 loop.json 里的
 * 远程 URL 不经 /plan 的 assertSafeRepo，这里再挡一道任意 scheme/host）。
 * 非 https（本地路径 / ssh / git@）无 token 泄漏面，直接放行。
 */
export function assertAllowedPushHost(remoteUrl: string): void {
  let host: string;
  try {
    const u = new URL(remoteUrl);
    if (u.protocol !== "https:") return; // 不注入 token 的协议
    host = u.host.toLowerCase();
  } catch {
    return; // 非 URL（本地路径）→ 不注入 token
  }
  if (!allowedPushHosts().includes(host)) {
    throw new Error(`repo host 不在 push 白名单：${host}（允许：${allowedPushHosts().join(", ")}）`);
  }
}

interface GitAuth {
  /** 送给 git 的 URL：含用户名 x-access-token（非机密），但**不含** token。 */
  url: string;
  /** token 经 GIT_ASKPASS 从 env 提供，不进 argv、不写 .git/config。 */
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}

/**
 * 构造带凭证的 git 认证（对齐 fde-copilot #32 的不变量）：
 * token 走临时 GIT_ASKPASS 脚本从 env 读，**绝不进 argv / .git/config**。
 * 原因：argv 经 `ps` 对同用户可见,并发池(#37)下另一 job 可执 Bash 的 coder 能 `ps aux`
 * 偷走共享 push token —— 正中沙箱威胁模型。username `x-access-token` 非机密,进 argv 无妨。
 * 非 https 或无 token：原样，无 askpass。
 */
async function buildAuth(remoteUrl: string, token?: string): Promise<GitAuth> {
  const noop: GitAuth = { url: remoteUrl, env: {}, cleanup: async () => {} };
  if (!token) return noop;
  let u: URL;
  try {
    u = new URL(remoteUrl);
  } catch {
    return noop; // 本地路径
  }
  if (u.protocol !== "https:") return noop;
  assertAllowedPushHost(remoteUrl); // 注入 token 前双保险
  u.username = "x-access-token";
  u.password = ""; // token 不进 URL
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loop-askpass-"));
  const askpass = path.join(dir, "askpass.sh");
  await fs.writeFile(askpass, `#!/bin/sh\nexec printf '%s' "$LOOP_GIT_TOKEN"\n`, { mode: 0o700 });
  return {
    url: u.toString(),
    env: { GIT_ASKPASS: askpass, LOOP_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }).catch(() => {}),
  };
}

/** 把 token 从报错里抹掉（防泄漏到持久化 status / 日志）。 */
function redact(s: string, token?: string): string {
  return token ? s.split(token).join("***") : s;
}

/**
 * 确保远程 repo 有一份本地 clone（W2/W4 补漏：loop 自己 clone 远程仓再编码/回推）。
 * - 已是 git 仓：best-effort fetch base（不 reset，保住已有 loop/integration 进度）。
 * - 路径存在但非 git 仓（残留半成品）：清掉重 clone。
 * - 缺失：clone。token 走 GIT_ASKPASS（不进 argv/.git/config）。
 */
export async function ensureClone(
  remoteUrl: string,
  localPath: string,
  baseBranch: string,
  token?: string,
): Promise<void> {
  assertAllowedPushHost(remoteUrl); // 纵深:即便无 token,https 也须落白名单 host
  const auth = await buildAuth(remoteUrl, token);
  try {
    if (await isGitRepo(localPath)) {
      await tryGit(localPath, ["fetch", auth.url, baseBranch], auth.env);
      return;
    }
    const exists = await fs
      .access(localPath)
      .then(() => true)
      .catch(() => false);
    if (exists) await fs.rm(localPath, { recursive: true, force: true });
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    try {
      await pexec("git", ["clone", auth.url, localPath], {
        ...GIT_EXEC_OPTS,
        env: { ...GIT_EXEC_OPTS.env, ...auth.env },
      });
    } catch (e) {
      throw new Error(redact((e as Error).message, token));
    }
    // origin 用干净 URL（无 token、无 x-access-token 用户名），保持 .git/config 干净
    await tryGit(localPath, ["remote", "set-url", "origin", remoteUrl]);
  } finally {
    await auth.cleanup();
  }
}

/**
 * 把本地分支 push 回远程若干 refspec（token 走 GIT_ASKPASS，不进 argv/.git/config）。
 * 逐条独立 push：某条失败（如 main 非 fast-forward）不影响其它条落地。
 */
export async function pushRefs(
  repo: string,
  remoteUrl: string,
  refspecs: string[],
  token?: string,
): Promise<{ pushed: boolean; detail: string }> {
  const auth = await buildAuth(remoteUrl, token);
  const okRefs: string[] = [];
  const failRefs: string[] = [];
  try {
    for (const spec of refspecs) {
      const r = await tryGit(repo, ["push", auth.url, spec], auth.env);
      if (r === null) failRefs.push(spec);
      else okRefs.push(spec);
    }
  } finally {
    await auth.cleanup();
  }
  if (failRefs.length === 0) return { pushed: true, detail: `已 push：${okRefs.join(" ")}` };
  return {
    pushed: okRefs.length > 0,
    detail: `push 部分/全部失败 —— 成功[${okRefs.join(" ") || "无"}] 失败[${failRefs.join(" ")}]`,
  };
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await tryGit(repo, ["rev-parse", "--verify", "--quiet", branch])) !== null;
}

/**
 * 防御式解析「基线起点」ref(容错/幂等):本地 baseBranch 缺失或未出生(空仓首 clone / 已存在仓只 fetch 未更新
 * 本地分支)时,依次退到 origin/base、FETCH_HEAD、HEAD。全都没有 = 仓库无任何提交 → 抛**友好错误**(会成为
 * 回传给前端的失败 reason)。修 CC-69 E2E:`git branch loop/integration main` 在陈旧/空仓上找不到 main 而挂。
 */
async function resolveBaseRef(repo: string, baseBranch: string): Promise<string> {
  for (const ref of [baseBranch, `origin/${baseBranch}`, "FETCH_HEAD", "HEAD"]) {
    if (await branchExists(repo, ref)) return ref;
  }
  throw new Error(
    `目标仓库没有可用的基线提交(找不到 ${baseBranch} / origin/${baseBranch} / FETCH_HEAD / HEAD)——` +
      `大概率是**空仓库(无任何提交)**。请让前端的建仓/commit 步骤先创建一个初始提交(哪怕只放一个 README),再触发编码。`,
  );
}

/**
 * 确保集成分支存在，并为它建一个专用 worktree（合并都在这里做，
 * 目标 repo 的主工作树全程不被 checkout 打扰）。返回集成 worktree 路径。
 */
export async function ensureIntegrationWorktree(
  repo: string,
  baseBranch: string,
  integrationBranch: string,
): Promise<string> {
  const wtPath = path.join(wtRoot(repo), "__integration__");

  if (!(await branchExists(repo, integrationBranch))) {
    const base = await resolveBaseRef(repo, baseBranch); // 容错:base 本地缺失/未出生 → 退 origin/FETCH_HEAD/HEAD
    await git(repo, ["branch", integrationBranch, base]);
    log.ok(`建集成分支 ${integrationBranch}（自 ${base}）`);
  }

  // 已挂载？
  const list = (await tryGit(repo, ["worktree", "list", "--porcelain"])) ?? "";
  if (!list.includes(wtPath)) {
    await fs.mkdir(path.dirname(wtPath), { recursive: true });
    await git(repo, ["worktree", "add", wtPath, integrationBranch]);
    log.ok(`挂载集成 worktree ${wtPath}`);
  }
  return wtPath;
}

/** 为一个任务建独立 worktree，分支起点 = 集成分支当前 tip */
export async function createTaskWorktree(
  repo: string,
  integrationBranch: string,
  taskBranch: string,
): Promise<string> {
  const wtPath = path.join(wtRoot(repo), safeBranch(taskBranch));
  // 若残留同名分支/worktree，先清
  await removeWorktree(repo, wtPath);
  if (await branchExists(repo, taskBranch)) {
    await tryGit(repo, ["branch", "-D", taskBranch]);
  }
  await fs.mkdir(path.dirname(wtPath), { recursive: true });
  await git(repo, ["worktree", "add", wtPath, "-b", taskBranch, integrationBranch]);
  return wtPath;
}

/** 清理该 repo 下已失效/遗留的 worktree 记录（超时/失败后的半成品清理，尽力而为）。 */
export async function pruneWorktrees(repo: string): Promise<void> {
  await tryGit(repo, ["worktree", "prune"]);
}

export async function removeWorktree(repo: string, wtPath: string): Promise<void> {
  const exists = await fs
    .access(wtPath)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    await tryGit(repo, ["worktree", "remove", "--force", wtPath]);
  }
  await tryGit(repo, ["worktree", "prune"]);
}

// 生成物/依赖目录：绝不该进 commit 或评审 diff。coder 若没写 .gitignore,`git add -A`
// 会把整个 node_modules(几千文件)提交 → 评审 diff 被淹没 + 60k 截断 → 评审「关键实现 diff
// 缺失」误判打回 → 任务假失败(真实故障根因,见 CC-60 stockalert)。
const VENDOR_DIRS = ["node_modules", ".next", "dist", "build", ".turbo", "coverage", ".venv", "__pycache__", "target"] as const;
const BASELINE_IGNORES = [...VENDOR_DIRS.map((d) => `${d}/`), ".env", ".env.local", ".env.*.local", "*.log", ".DS_Store"];
// review diff 的 pathspec：`:/` = 仓库根(含全部)；`:(exclude,glob)**/dir/**` = 排除任意深度的 vendored。
// 用 glob(而非 `.` 或 `top`)：
//   - `.` 依赖 git 进程 cwd(生产里 server cwd ≠ worktree)会失配；
//   - `top` 只锚定仓库根,匹配不到 monorepo 的嵌套 packages/*/node_modules(pr-daemon #66 review 实证)。
// glob `**/dir/**` 与 .gitignore 的 `dir/` 同义:任意深度都命中。
const DIFF_INCLUDE_ROOT = ":/";
const DIFF_EXCLUDES = VENDOR_DIRS.map((d) => `:(exclude,glob)**/${d}/**`);
/** `git rm --cached` 用的 glob pathspec:匹配任意深度 vendored 目录下的文件(root + 嵌套)。 */
const VENDOR_RM_GLOBS = VENDOR_DIRS.map((d) => `:(glob)**/${d}/**`);

/**
 * 确保 worktree 有基线 .gitignore（幂等：只补缺失行）。在首次 commit 前调,防 coder 忘写
 * .gitignore 时 `git add -A` 把 node_modules 卷进提交/评审 diff。
 */
async function ensureGitignore(wtPath: string): Promise<void> {
  const gi = path.join(wtPath, ".gitignore");
  let existing = "";
  try {
    existing = await fs.readFile(gi, "utf8");
  } catch {
    /* 无 .gitignore → 新建 */
  }
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = BASELINE_IGNORES.filter((v) => !have.has(v));
  if (missing.length === 0) return;
  const banner = existing && !existing.endsWith("\n") ? "\n" : "";
  await fs.writeFile(gi, `${existing}${banner}# loop-engineer baseline ignores\n${missing.join("\n")}\n`, "utf8");
}

/** 任务分支相对集成分支的 diff（喂给单发 chat reviewer；排除 vendored + 容量上限保护） */
export async function diffAgainst(wtPath: string, integrationBranch: string): Promise<string> {
  const range = `${integrationBranch}...HEAD`;
  // 双保险：即便 vendored 目录不慎被提交,评审 diff 也只看真实源码(否则真实现被 node_modules 挤掉+截断)。
  const diff = (await tryGit(wtPath, ["diff", range, "--", DIFF_INCLUDE_ROOT, ...DIFF_EXCLUDES])) ?? "";
  const stat = (await tryGit(wtPath, ["diff", "--stat", range, "--", DIFF_INCLUDE_ROOT, ...DIFF_EXCLUDES])) ?? "";
  const capped = diff.length > 60_000 ? diff.slice(0, 60_000) + "\n…(diff 过长已截断)" : diff;
  return `## 改动概览\n${stat}\n\n## 完整 diff\n${capped}`;
}

export async function hasChanges(wtPath: string): Promise<boolean> {
  const s = await tryGit(wtPath, ["status", "--porcelain"]);
  return !!s;
}

/**
 * 提交 worktree 全部改动。**有副作用（刻意为之的策略）**：
 *  1. 首次提交前补一份基线 .gitignore（node_modules/.next/.env 等），防 coder 忘写 → `git add -A`
 *     把 node_modules 卷进提交/评审 diff（CC-60 假失败根因）。gitignore 的 `dir/` 匹配任意深度。
 *  2. 把已被 tracked 的 vendored（历史 attempt 提交过的，.gitignore 对已跟踪文件无效）从暂存区剔除，
 *     含 monorepo 的嵌套 node_modules（glob pathspec，见 VENDOR_RM_GLOBS）。
 */
export async function commitAll(wtPath: string, message: string): Promise<boolean> {
  await ensureGitignore(wtPath); // 先落基线 .gitignore,让 add -A 天然跳过 node_modules 等(含嵌套)
  await git(wtPath, ["add", "-A"]);
  // 已 tracked 的 vendored（root + 嵌套）→ 从暂存区剔除,不进本次 commit/评审 diff。--ignore-unmatch:没有也不报错。
  await tryGit(wtPath, ["rm", "-r", "--cached", "--ignore-unmatch", "--", ...VENDOR_RM_GLOBS]);
  if (!(await hasChanges(wtPath))) return false;
  await git(wtPath, ["commit", "-m", message]);
  return true;
}

/** 在集成 worktree 里把任务分支 --no-ff 合并进集成分支 */
export async function mergeToIntegration(
  integrationWtPath: string,
  taskBranch: string,
  message: string,
): Promise<void> {
  await git(integrationWtPath, ["merge", "--no-ff", taskBranch, "-m", message]);
}

export interface PrResult {
  opened: boolean;
  url?: string;
  detail: string;
}

/**
 * 尽力开 PR：需要 remote + gh。推 taskBranch 并对 integrationBranch 开 PR。
 * 本地无 remote/gh 时优雅跳过（仍会在本地合并到集成分支）。
 */
export async function openPr(
  repo: string,
  taskBranch: string,
  integrationBranch: string,
  title: string,
  body: string,
): Promise<PrResult> {
  const hasRemote = await tryGit(repo, ["remote"]);
  if (!hasRemote) return { opened: false, detail: "无 remote，跳过 PR，走本地集成合并" };

  const pushed = await tryGit(repo, ["push", "-u", "origin", taskBranch]);
  if (pushed === null) return { opened: false, detail: "push 失败，跳过 PR" };

  try {
    const { stdout } = await pexec(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        await repoSlug(repo),
        "--base",
        integrationBranch,
        "--head",
        taskBranch,
        "--title",
        title,
        "--body",
        body,
      ],
      { cwd: repo },
    );
    return { opened: true, url: stdout.trim(), detail: "PR 已开" };
  } catch (e) {
    return { opened: false, detail: `gh pr create 失败：${(e as Error).message.slice(0, 200)}` };
  }
}

async function repoSlug(repo: string): Promise<string> {
  const url = (await tryGit(repo, ["remote", "get-url", "origin"])) ?? "";
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  return m ? m[1] : "";
}
