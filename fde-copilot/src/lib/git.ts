import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectDir, readAllDocs } from "./clients";

const pexec = promisify(execFile);

// 仓库根 = fde-copilot 的上一级（本子项目位于大 repo 内）
function repoRoot(): string {
  return path.resolve(process.cwd(), "..");
}

async function git(args: string[], cwd = repoRoot()): Promise<string> {
  const { stdout } = await pexec("git", args, { cwd, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

export interface CommitResult {
  committed: boolean;
  pushed: boolean;
  detail: string;
  /** push 到目标仓库时的提交 sha（W2） */
  sha?: string;
  /** push 到的目标远程（脱敏，无凭证） */
  repo?: string;
}

export interface CommitOptions {
  /** 显式要求 push（无 repo 时 push 到大 repo 默认 remote，行为同旧版） */
  push?: boolean;
  /**
   * W2：目标公有仓库远程 URL（参赛者命名、我方 PAT 账户下）。
   * 给定后，spec 文档被物化进该仓库的一次性 clone 并 push 到那里，
   * 而不是把整个内部 monorepo push 出去。
   */
  repo?: string;
  /**
   * W2：push 用的 token（hack5 侧注入的仓库级、短时效 fine-grained token，见 B2）。
   * 不传则回落到环境变量 WORKBENCH_PUSH_TOKEN。绝不硬编码，绝不写日志。
   */
  pushToken?: string;
}

/**
 * 提交某客户目录下的 spec 文档（不含 state.json / conversation.jsonl，已被 .gitignore）。
 *
 * - 未给 `repo`：提交进大 repo，`push` 时 push 到其默认 remote（旧行为，向后兼容）。
 * - 给了 `repo`（W2）：把 spec 物化进目标公有仓库并 push 到那里（见 pushSpecToRepo）。
 */
export async function commitProject(
  clientSlug: string,
  projectSlug: string,
  message: string,
  opts: CommitOptions = {},
): Promise<CommitResult> {
  // W2：指定目标仓库 → 走独立的「物化 + push 到该仓库」路径
  if (opts.repo) {
    return pushSpecToRepo(clientSlug, projectSlug, message, opts.repo, resolvePushToken(opts.pushToken));
  }

  const rel = path.relative(repoRoot(), projectDir(clientSlug, projectSlug));
  // CC-77：.workset-dirty 是本地盘的运行时状态标记（见 clients.ts LOCAL_DIRTY_MARK），
  // 不是交付内容 —— 排除掉，免得它进仓库，也免得「只有标记变了」被误判成有文档变更。
  const markPath = `${rel.split(path.sep).join("/")}/.workset-dirty`;
  const noMark = `:(exclude)${markPath}`;
  // :(exclude) 只管「本次不 stage」，管不了它之前是否已被外部 stage 过 —— 那种情况它会留在 index 里，
  // 迟早被别的提交带走。开头显式 unstage 一次（未 staged / 空仓时是 no-op，失败无害）。
  await git(["reset", "--quiet", "--", markPath]).catch(() => {});
  await git(["add", "--", rel, noMark]);

  // 无变更则跳过
  const status = await git(["status", "--porcelain", "--", rel, noMark]);
  if (!status) {
    return { committed: false, pushed: false, detail: "无文档变更，跳过提交" };
  }

  await git([
    "commit",
    "-m",
    message,
    "-m",
    "Claude-Session: https://claude.ai/code/session_01Auxf6v5qsq3sNYjDP5qcnX",
    "--",
    rel,
    noMark,
  ]);

  let pushed = false;
  let detail = `已提交 ${rel}`;
  if (opts.push) {
    try {
      await git(["push"]);
      pushed = true;
      detail += "，已 push";
    } catch (e) {
      detail += `，push 失败：${(e as Error).message}`;
    }
  }
  return { committed: true, pushed, detail };
}

function resolvePushToken(token?: string): string | undefined {
  return token || process.env.WORKBENCH_PUSH_TOKEN || undefined;
}

/**
 * W2：把项目 spec 文档 push 到指定的目标公有仓库。
 *
 * 做法：一次性 clone 目标仓库到临时目录（空仓也可 clone），把 spec 文档写进 `spec/`，
 * 提交并 push 到目标分支（默认 main）。这样 spec 进的是**参赛者的公有仓库**，
 * 而非把整个内部 monorepo 推出去；也不与 loop-engineer 推的应用代码抢根目录。
 *
 * 安全：token 只用于构造带凭证的 push URL，绝不进入返回值/日志；git 报错做脱敏。
 */
export async function pushSpecToRepo(
  clientSlug: string,
  projectSlug: string,
  message: string,
  repoUrl: string,
  token?: string,
): Promise<CommitResult> {
  const docs = await readAllDocs(clientSlug, projectSlug);
  if (Object.keys(docs).length === 0) {
    return { committed: false, pushed: false, detail: "无 spec 文档，跳过", repo: repoUrl };
  }

  // #1：注入 token 前先校验 host 白名单，绝不把 push token 发往非预期主机
  if (token) assertAllowedPushHost(repoUrl);

  const branch = process.env.WORKBENCH_PUSH_BRANCH || "main";
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wb-spec-"));
  const work = path.join(tmp, "repo");
  try {
    // token 走 GIT_ASKPASS（env），不进 argv、不落 .git/config
    const auth = await buildPushAuth(repoUrl, token, tmp);
    // clone（空仓库也会成功，只是警告）；报错脱敏 token
    await runGit(["clone", auth.url, work], tmp, token, auth.env);

    // 写 spec 文档到 spec/ 子目录
    const specDir = path.join(work, "spec");
    await fs.mkdir(specDir, { recursive: true });
    await Promise.all(
      Object.entries(docs).map(([file, content]) => fs.writeFile(path.join(specDir, file), content, "utf8")),
    );

    await runGit(["add", "-A"], work, token);
    const status = await runGit(["status", "--porcelain"], work, token);
    if (!status) {
      return { committed: false, pushed: false, detail: "目标仓库 spec 无变更，跳过", repo: repoUrl };
    }

    await runGit(
      [
        "-c",
        "user.name=WorkBench Bot",
        "-c",
        "user.email=bot@workbench.local",
        "commit",
        "-m",
        message,
      ],
      work,
      token,
    );
    const sha = await runGit(["rev-parse", "HEAD"], work, token);
    await runGit(["push", "origin", `HEAD:refs/heads/${branch}`], work, token, auth.env);

    return { committed: true, pushed: true, sha, detail: `spec 已 push 到目标仓库（${branch}）`, repo: repoUrl };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** 允许注入 push token 的 host 白名单（默认 github.com；WORKBENCH_ALLOWED_PUSH_HOSTS 逗号分隔可扩展）。 */
function allowedPushHosts(): string[] {
  const raw = process.env.WORKBENCH_ALLOWED_PUSH_HOSTS;
  return (raw ? raw.split(",") : ["github.com"]).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * #1：注入 push token 前的 host 白名单校验。
 * 只有 https 才会注入 token —— 若其 host 不在白名单 → 抛错（防 `repo=https://evil.com` 把
 * push 凭证发到任意主机）。非 https（ssh/git@/file/本地路径）不注入 token，直接放行。
 */
export function assertAllowedPushHost(repoUrl: string): void {
  let host: string;
  try {
    const u = new URL(repoUrl);
    if (u.protocol !== "https:") return; // 不注入 token 的协议，无泄漏面
    host = u.host.toLowerCase();
  } catch {
    return; // 非 URL（本地路径）→ 不注入 token
  }
  if (!allowedPushHosts().includes(host)) {
    throw new Error(`repo host 不在 push 白名单：${host}（允许：${allowedPushHosts().join(", ")}）`);
  }
}

interface PushAuth {
  /** 送给 git 的 URL：含用户名 x-access-token（非机密），但**不含** token */
  url: string;
  /** token 经 GIT_ASKPASS 从 env 提供，不进 argv、不写 .git/config */
  env: Record<string, string>;
}

/**
 * 构造 push 认证（小 finding：token 不进 argv / 不落盘）。
 * https + token：URL 只带用户名，token 走 GIT_ASKPASS（env `WB_GIT_TOKEN`）。
 * 非 https 或无 token：原样，无 askpass。
 */
async function buildPushAuth(repoUrl: string, token: string | undefined, tmp: string): Promise<PushAuth> {
  if (!token) return { url: repoUrl, env: {} };
  let u: URL;
  try {
    u = new URL(repoUrl);
  } catch {
    return { url: repoUrl, env: {} }; // 本地路径
  }
  if (u.protocol !== "https:") return { url: repoUrl, env: {} };
  assertAllowedPushHost(repoUrl); // 双保险
  u.username = "x-access-token";
  u.password = ""; // token 不进 URL
  const askpass = path.join(tmp, "askpass.sh");
  await fs.writeFile(askpass, `#!/bin/sh\nexec printf '%s' "$WB_GIT_TOKEN"\n`, { mode: 0o700 });
  return {
    url: u.toString(),
    env: { GIT_ASKPASS: askpass, WB_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
  };
}

/** git 执行 + 错误脱敏（把 token 从报错里抹掉，防泄漏到响应/日志） */
async function runGit(
  args: string[],
  cwd: string,
  token?: string,
  extraEnv?: Record<string, string>,
): Promise<string> {
  try {
    const { stdout } = await pexec("git", args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    return stdout.trim();
  } catch (e) {
    throw new Error(redact((e as Error).message, token));
  }
}

function redact(s: string, token?: string): string {
  return token ? s.split(token).join("***") : s;
}
