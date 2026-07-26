#!/usr/bin/env -S npx tsx
/**
 * W1 — loop-engineer 薄 HTTP 编排 API
 *
 * 让 hack5（Cloudflare Worker，碰不到 Mac Mini 文件系统）能远程触发编码循环。
 * 复用现有函数：planSpec（planner.ts）、runTask（orchestrator.ts）、jobs.ts 的 job 模型。
 *
 * 契约（见 docs/hack5-对接-实现计划.md §1）：
 *   POST /plan      { clientSlug, projectSlug, repo, spec? } → { jobId }
 *                   spec 可选：markdown 全文，内联"上传现成 spec 一键构建"，写进 specDir 当 SPEC.md 直接建 job。
 *   POST /run       { jobId }                         → { started, state }
 *   GET  /status/:jobId  → { state, progress{total,done,percent,current}, tasks[], costUsd, prUrl?, appUrl? }
 *   GET  /spec/:jobId    → { spec, docs{}, tasks[] }  —— 正在基于哪些规格开发 + 任务清单
 *   POST /deploy         { clientSlug, projectSlug, repo } → { appUrl, expiresAt, selfDeployHint }
 *                        —— 一键部署作品仓到 CF Pages(内置账号),7 天自动删,发 deployed 回调
 *
 * 鉴权：所有端点校验 `x-workbench-token`（复用 WORKBENCH_TOKEN，与 fde-copilot 一致）。
 *
 * 并发（B1）：底层引擎串行，这里用单 worker 队列。busy 时 /run 返回 state:"queued"
 * （入队语义，不 409），worker 空出即自动开跑。一场 Mini 几十个想法可安全排队。
 *
 * 安全（B4）：默认只绑 127.0.0.1。远程可达须经隧道（token + 网络管控做补偿控制）。
 * 状态存储为进程内内存：重启丢失（对 W1 mock 自测足够；持久化留后续）。
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { loadConfig, loadEnv, PROJECT_ROOT } from "./config.js";
import { loadJob, nextTask, hasPending, saveJob, scanJobs } from "./jobs.js";
import { planSpec } from "./planner.js";
import { estimateJob } from "./estimate.js";
import { runTask } from "./orchestrator.js";
import { isGitRepo, pruneWorktrees, isRemoteRepo, ensureClone, pushRefs } from "./git.js";
import { runWithTimeout } from "./timeout.js";
import { writeStatus, readStatus } from "./persist.js";
import { checkWorkbenchToken, checkOrigin } from "./auth.js";
import { emitLifecycle, type PhaseUsage } from "./lifecycle.js";
import { createPool } from "./pool.js";
import { installCallbackSink } from "./callback.js";
import { cfCreds, deployStaticDir, buildIfNeeded, cleanupExpiredPages } from "./deploy.js";
import { routePath } from "./routing.js";
import { genSpec } from "./genspec.js";
import { log } from "./log.js";
import { ZERO, add } from "./usage.js";
import type { Usage } from "./usage.js";
import type { Config, LoadedJob } from "./types.js";

// —— 契约状态机 ——
type JobState = "queued" | "planning" | "coding" | "reviewing" | "done" | "failed";

interface JobRecord {
  jobId: string;
  specDir: string;
  repo: string;
  clientSlug: string;
  projectSlug: string;
  state: JobState;
  prUrl?: string;
  appUrl?: string;
  error?: string;
  updatedAt: string;
  /** B1：/plan 入队时置 true —— 后台 job 先跑 planSpec(拆规格)再跑任务,避免 /plan 同步阻塞。 */
  needsPlan?: boolean;
  /** CC-54：本 job 累计用量(planning + 各任务 coder/reviewer)。coding_done/failed 回调回传 costUsd。 */
  usage: Usage;
  /** Fix B：分节用量(每关键节点花多少/积分/卡点)。随 coding_done/failed 回调 durable 送前端。 */
  phases: PhaseUsage[];
  /** CC-63 P1 review(#71):task 代际。每起一个 task ++;超时后被放弃的孤儿 task 的 onPhase 回写
   * 用旧代际,setState 前比对 → 忽略,防孤儿覆盖已推进/终态的 state。 */
  gen: number;
}

const isTerminalState = (s: JobState): boolean => s === "done" || s === "failed";

/** 记一个节点的用量到 job(planning / 各任务)。credits 展示用;计费仍以事件级 costUsd 总额为准。 */
function pushPhase(rec: JobRecord, stage: string, u: Usage): void {
  rec.phases.push({
    stage,
    costUsd: u.costUsd,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    credits: Math.ceil(u.costUsd * 100),
  });
}

/** 从规格目录反推 clientSlug/projectSlug（.../clients/<c>/projects/<p>） */
function clientProjectFromSpecDir(specDir: string): { clientSlug: string; projectSlug: string } {
  const projectSlug = path.basename(specDir);
  const clientSlug = path.basename(path.dirname(path.dirname(specDir)));
  return { clientSlug, projectSlug };
}

const registry = new Map<string, JobRecord>();

function setState(rec: JobRecord, state: JobState, patch?: Partial<JobRecord>): void {
  // CC-63 P1 review(#71):终态单调 —— 一旦 done/failed,忽略中间态回写(如超时后被放弃的孤儿 task
  // 迟到的 onPhase「coding/reviewing」)。否则会覆盖已终态 + 已发终态回调的 state,破坏 phases/state
  // 单调向终态的不变量(#67/#69/hack5#77 依赖它)。终态→终态(如兜底再标 failed)仍放行。
  if (isTerminalState(rec.state) && !isTerminalState(state)) return;
  rec.state = state;
  if (patch) Object.assign(rec, patch);
  rec.updatedAt = new Date().toISOString();
  // C1：状态落盘(fire-and-forget,last-write-wins),重启后 /status 仍可查
  void persist(rec);
}

/** 把 rec 快照写到其规格目录 .loop/status.json（失败仅告警，不打断编排）。 */
async function persist(rec: JobRecord): Promise<void> {
  try {
    await writeStatus(rec.specDir, {
      jobId: rec.jobId,
      repo: rec.repo,
      clientSlug: rec.clientSlug,
      projectSlug: rec.projectSlug,
      state: rec.state,
      prUrl: rec.prUrl,
      appUrl: rec.appUrl,
      error: rec.error,
      updatedAt: rec.updatedAt,
      usage: { inputTokens: rec.usage.inputTokens, outputTokens: rec.usage.outputTokens, costUsd: rec.usage.costUsd },
      phases: rec.phases,
    });
  } catch (e) {
    log.warn(`状态落盘失败(${rec.jobId})：${(e as Error).message}`);
  }
}

/**
 * Fix A（CC-57）：job 终态时把本 job 的 loop 用量按 project 回写进 fde-copilot 的 state.json，
 * 让 `GET /api/usage` 的逐-project 项含真实 loop 编码成本（此前 p.usage 只被 chat 路由写，
 * loop 成本只走回调 body / .loop/usage.json，从不进 /api/usage 读的 store）。
 *
 * `specDir` 就是 fde-copilot 的 project 目录（watchDir/<c>/projects/<p>），state.json 在此。
 * 语义与 chat 侧一致（累加，非覆盖）；loop 的 `calls` 计入 fde 的 `turns` 计数。原子写（tmp+rename）
 * 避免与并发的 /api/usage 读撞到半截文件。**每个 job 终态只调一次**（done 分支 + failed 兜底分支互斥）。
 * 失败仅告警、不打断编排——回调 body 仍带 costUsd 作冗余口径。
 */
async function mergeLoopUsageIntoProjectState(specDir: string, u: Usage): Promise<void> {
  const statePath = path.join(specDir, "state.json");
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<string, unknown>;
  } catch {
    // state.json 缺失（正常流程 chat 先跑会建它）——不凭空造 fde schema，跳过并告警。
    log.warn(`Fix A：未找到 ${statePath}，跳过 loop usage 回写`);
    return;
  }
  const prev = (state.usage ?? {}) as Record<string, number>;
  state.usage = {
    inputTokens: (prev.inputTokens ?? 0) + u.inputTokens,
    outputTokens: (prev.outputTokens ?? 0) + u.outputTokens,
    cacheReadTokens: (prev.cacheReadTokens ?? 0) + u.cacheReadTokens,
    costUsd: (prev.costUsd ?? 0) + u.costUsd,
    computeMs: (prev.computeMs ?? 0) + u.computeMs,
    turns: (prev.turns ?? 0) + u.calls, // loop 的 calls 归入 fde 的 turns 计数
  };
  state.updatedAt = new Date().toISOString();
  const tmp = `${statePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await fs.rename(tmp, statePath); // 原子替换
  log.ok(`Fix A：loop 成本回写 ${path.basename(specDir)}/state.usage（+$${u.costUsd.toFixed(4)}）`);
}

// —— 有界并发池（W7）——
// 契约 v2 · B1:v1 默认串行(LOOP_CONCURRENCY=1);一场 Mini 几十个想法可把并发调高。
// 以 repo 作 key → 同 repo 的 job 串行(worktree/集成分支互斥)、跨 repo 并行。
let config: Config;

function maxConcurrency(): number {
  const n = Number(process.env.LOOP_CONCURRENCY ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

const pool = createPool(maxConcurrency);

/** 提交一个 job 到并发池（以其 repo 为互斥 key）。 */
function enqueue(jobId: string): void {
  const rec = registry.get(jobId);
  if (!rec) return;
  pool.submit({
    id: jobId,
    key: rec.repo,
    run: async () => {
      // Q2:job 级超时。超时 → abort（kill 子进程 + runTask.finally 清 worktree）→ 标 failed。
      const r = await runWithTimeout(async (signal) => {
        // B1：/plan 只入队秒返回,真正的拆规格(planSpec,分钟级)在这里后台跑,不阻塞 HTTP。
        const r0 = registry.get(jobId);
        if (r0?.needsPlan) {
          setState(r0, "planning");
          const planUsage = await planSpec(r0.specDir, config, { repo: r0.repo });
          r0.usage = add(r0.usage, planUsage); // CC-54：planning 成本计入 job
          pushPhase(r0, "planning", planUsage); // Fix B：planning 节点成本
          r0.needsPlan = false;
        }
        if (signal?.aborted) return;
        await processJob(jobId, signal);
      }, jobTimeoutMs());
      const job = registry.get(jobId);
      if (r.timedOut) {
        if (job) setState(job, "failed", { error: `job 超时（${jobTimeoutMs()}ms），已中止并清理` });
        log.err(`job ${jobId} 超时中止`);
        await pruneRepoWorktrees(job?.repo);
      } else if (r.error) {
        if (job) setState(job, "failed", { error: (r.error as Error).message });
        log.err(`job ${jobId} 处理异常：${(r.error as Error).message}`);
      }
      // 统一失败回调：不论 job 是任务失败(processJob 内置 failed)、超时还是异常收尾，
      // 只要终态为 failed 就发一次 failed 回调 —— 否则 hack5 会一直干等 build。coding_done
      // 由 processJob 成功路径自己发，这里只兜底 failed，不会重复。
      const fin = registry.get(jobId);
      if (fin && fin.state === "failed") {
        // Fix A（CC-57）：失败 job 也把已花的 loop 成本回写(与 done 分支互斥，各终态只一次)，
        // 免得 /api/usage 对失败 build 少记账。与 failed 回调的 costUsd 同口径。
        await mergeLoopUsageIntoProjectState(fin.specDir, fin.usage);
        await emitLifecycle({
          event: "failed",
          clientSlug: fin.clientSlug,
          projectSlug: fin.projectSlug,
          repo: fin.repo,
          error: fin.error,
          // CC-54：即便失败也回传已花的成本(hack5 可按策略决定是否扣/退)
          costUsd: fin.usage.costUsd,
          inputTokens: fin.usage.inputTokens,
          outputTokens: fin.usage.outputTokens,
          phases: fin.phases, // Fix B：失败也带分节明细(每步花多少 + 卡在哪)
        });
      }
    },
  });
}

/**
 * loop 回推远程仓用的 push token。B2 边界：只在编排进程（server）里读，用于构造带凭证的
 * 临时 push/clone URL；sandboxEnv() 白名单不含这些键，coder/reviewer 沙箱读不到。
 * 凭据留在本机 loop-engineer/.env，绝不经 hack5 过线（契约不变，hack5 零改动）。
 */
function loopPushToken(): string | undefined {
  // WORKBENCH_PUSH_TOKEN 是对外文档 + CF Worker passthrough 用的名字（PR #57 review：修名字对不上，
  // 否则按 deploy/README 一字不差操作会静默拿到 undefined）。保留旧名兼容。
  return (
    process.env.WORKBENCH_PUSH_TOKEN ||
    process.env.LOOP_GIT_PUSH_TOKEN ||
    process.env.GITHUB_BOT_TOKEN ||
    undefined
  );
}

/** job 级超时上限（默认 60min）。多任务应用(骨架+逐个功能+返工)30min 常不够，放宽到 60min。 */
function jobTimeoutMs(): number {
  const DEFAULT = 60 * 60 * 1000;
  const n = Number(process.env.LOOP_JOB_TIMEOUT_MS ?? DEFAULT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT;
}

/** 每-task 超时（默认 15min）。单个 plan/code/review 任务卡死 → 快速判该 task 失败,不拖满 job 超时。 */
function taskTimeoutMs(): number {
  const DEFAULT = 15 * 60 * 1000;
  const n = Number(process.env.LOOP_TASK_TIMEOUT_MS ?? DEFAULT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT;
}

/** 合并 job 级 + task 级中止信号:任一 abort 即中止本 task。 */
function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  return a ? AbortSignal.any([a, b]) : b;
}

/** 超时/失败后清理该 repo 遗留的半成品 worktree（尽力而为）。 */
async function pruneRepoWorktrees(repo?: string): Promise<void> {
  if (!repo) return;
  try {
    await pruneWorktrees(repo);
  } catch (e) {
    log.warn(`worktree 清理失败：${(e as Error).message}`);
  }
}

/** 跑一个 job 的全部待办任务到收工，实时更新 registry 状态。 */
async function processJob(jobId: string, signal?: AbortSignal): Promise<void> {
  const rec = registry.get(jobId);
  if (!rec) return;
  const job = await loadJob(path.join(rec.specDir, "loop.json"));
  if (!job) {
    setState(rec, "failed", { error: "loop.json 不存在或不可解析" });
    return;
  }
  // W2/W4 补漏：repo 是远程 URL 时，loop 先把它 clone 到本地 job 目录，再编码/回推。
  // （之前 loadJob 会把 URL 当本地路径拼歪 → isGitRepo=false → job 秒挂。Bug1。）
  if (job.remoteUrl) {
    try {
      await ensureClone(job.remoteUrl, job.repoPath, job.manifest.baseBranch, loopPushToken());
    } catch (e) {
      setState(rec, "failed", { error: `clone 远程仓失败（${job.remoteUrl}）：${(e as Error).message}` });
      return;
    }
  }
  if (!(await isGitRepo(job.repoPath))) {
    setState(rec, "failed", { error: `目标 repo 不是 git 仓库：${job.repoPath}` });
    return;
  }

  setState(rec, "coding");
  while (hasPending(job)) {
    const task = nextTask(job);
    if (!task) break; // 有 pending 但被依赖阻塞
    task.status = "in_progress";
    await saveJob(job);
    // CC-63 P1：每-task 硬超时。task 卡死(子进程挂、评审模型不响应)→ runWithTimeout 强制返回,
    // 不再干等 → 判该 task failed → job 收工判 failed → 一定发 W5 failed 回调(不再悬空)。
    // review(#71):代际守卫 —— 本 task 领一个代际号;超时被放弃后,孤儿 continuation 迟到的
    // onPhase 用旧代际(rec.gen 已被下一 task/终态推进)→ 忽略,不覆盖已推进/终态的 state。
    const myGen = ++rec.gen;
    const r = await runWithTimeout(
      (taskSignal) =>
        runTask(job, task, config, {
          onPhase: (phase) => {
            if (rec.gen === myGen) setState(rec, phase);
          },
          signal: combineSignals(signal, taskSignal),
        }),
      taskTimeoutMs(),
    );
    rec.gen++; // task 结束(成功/超时/异常)→ 推进代际,使其孤儿 continuation 的后续 onPhase 失效
    if (r.timedOut) {
      task.status = "failed";
      task.lastResult = `task ${task.id} 超时（${Math.round(taskTimeoutMs() / 60000)}min），已中止`;
      await saveJob(job);
      log.err(`任务 ${task.id} 超时`);
      if (signal?.aborted) break; // job 级超时触发的 → 不再取下一个任务
    } else if (r.error) {
      task.status = "failed";
      task.lastResult = (r.error as Error).message;
      await saveJob(job);
      log.err(`任务 ${task.id} 异常：${(r.error as Error).message}`);
      if (signal?.aborted) break;
    } else {
      const result = r.value!;
      rec.usage = add(rec.usage, result.usage); // CC-54：每任务成本累加进 job
      pushPhase(rec, task.id, result.usage); // Fix B：本任务节点成本(coder + 评审 + 返工)
      if (result.prUrl) rec.prUrl = result.prUrl;
    }
  }

  const tasks = job.manifest.tasks;
  const failed = tasks.filter((t) => t.status === "failed");
  if (failed.length > 0) {
    // CC-60：人话摘要 —— 阶段 + 失败计数 + 首个失败任务的首行原因（整段日志由 callbackBody
    // 的 clampReason 兜底截断，这里先给一句能读的，而不是把每个 lastResult 全量拼起来）。
    const first = failed[0];
    const firstLine = (first.lastResult ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "无详情";
    setState(rec, "failed", {
      error: `coding 阶段 ${failed.length}/${tasks.length} 个任务失败；首个 ${first.id}：${firstLine}`,
    });
  } else {
    // W4：远程仓 → 回推编码成果。CC-69 加固(容错/幂等/友好/不谎报):
    //  - **integration 分支 = 代码落 GitHub,是「一键应用」的兑现,push 失败 = 硬失败**(不再静默报 done;
    //    否则 /deploy 部署到空 main、用户以为成功其实代码没上仓)。带**重试**(网络抖动/瞬时 5xx)+ **友好错误**。
    //  - base fast-forward(便于 /deploy 直接部署 main)是便利项,失败**不致命** —— 代码已在 integration 分支。
    //  幂等:重跑同 job 会重推,已存在的 ref 幂等更新。凭据来自本机 token,沙箱不可见。
    if (job.remoteUrl) {
      const integ = job.manifest.integrationBranch;
      const base = job.manifest.baseBranch;
      const token = loopPushToken();
      let integPush = { pushed: false, detail: "未尝试" };
      for (let a = 1; a <= 3; a++) {
        integPush = await pushRefs(job.repoPath, job.remoteUrl, [`${integ}:refs/heads/${integ}`], token);
        if (integPush.pushed) break;
        // pr-daemon #79(非阻塞):退避响应 AbortSignal —— job 被取消就别空等满 6s。
        if (a < 3 && !signal?.aborted) {
          log.warn(`回推 ${integ} 失败(第 ${a}/3 次),重试：${integPush.detail}`);
          await new Promise((r) => setTimeout(r, 2000 * a));
        } else break;
      }
      if (!integPush.pushed) {
        // 硬失败:代码没上 GitHub,别报 done。友好 reason 回传前端(与 coding 失败同一条通道)。
        setState(rec, "failed", {
          error:
            `代码构建成功,但回推 GitHub 失败、应用代码未上仓：${integPush.detail}。` +
            `多为 push 凭据对目标仓无写权限或缺失 —— 请检查 loop 的 WORKBENCH_PUSH_TOKEN / GITHUB_BOT_TOKEN 对 ${job.remoteUrl} 的写权限。`,
        });
        return;
      }
      // base fast-forward:失败仅告警(代码已在 integration 分支,可从该分支部署或手动合并)。
      const baseFF = await pushRefs(job.repoPath, job.remoteUrl, [`${integ}:${base}`], token);
      if (baseFF.pushed) log.ok(`回推远程 ${job.remoteUrl}：integration + ${base} 均已 push`);
      else log.warn(`${base} fast-forward 失败(代码已在 ${integ} 分支,可从该分支部署/手动合并)：${baseFF.detail}`);
    }
    setState(rec, "done");
    // Fix A（CC-57）：终态先把 loop 成本按 project 回写进 fde-copilot state.json，
    // 再发 coding_done。时序保证 usage 早于 hack5 settle（deployed 时才拉 /api/usage）落位，无 race。
    await mergeLoopUsageIntoProjectState(rec.specDir, rec.usage);
    // W4：coding 完成 → 广播 coding_done。部署归 hack5(只回调),此处不自部署。
    // sink 失败不影响 job 状态(emitLifecycle 内部各 sink 独立 try/catch)。
    await emitLifecycle({
      event: "coding_done",
      clientSlug: rec.clientSlug,
      projectSlug: rec.projectSlug,
      repo: rec.repo,
      prUrl: rec.prUrl,
      // CC-54：回传本 job 实际成本(按 hack5 权威价表逐模型算)供积分扣费
      costUsd: rec.usage.costUsd,
      inputTokens: rec.usage.inputTokens,
      outputTokens: rec.usage.outputTokens,
      phases: rec.phases, // Fix B：成功也带分节明细(每步花多少)
    });
  }
}

// —— HTTP 辅助 ——
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX_BODY = 2 * 1024 * 1024; // pr-daemon #79:请求体 2MB 上限,防无界缓冲 DoS。超限当空 body(→ 各 handler 400)。
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > MAX_BODY) {
      chunks.length = 0;
      break;
    }
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    return {};
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * POST /estimate { idea?, spec? } → { tier, creditsLow, creditsHigh, note, signals }
 * CC-62：事前把 idea/spec 估成积分区间,供 hack5 建 job 前做余额预检(够则放行、不够提示充值)。
 * 纯启发式,秒级返回、零 token 成本 —— 预估本身不烧积分。
 */
async function handleEstimate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const idea = typeof body.idea === "string" ? body.idea : undefined;
  const spec = typeof body.spec === "string" ? body.spec : undefined;
  if (!idea && !spec) {
    send(res, 400, { error: "需要 idea 或 spec 之一(文本)" });
    return;
  }
  send(res, 200, estimateJob({ idea, spec }));
}

/**
 * slug 安全校验：slug 直接来自 /plan 请求体（多租户 Worker 传入），path.join 不阻止 `..`。
 * 与 fde-copilot 的 clients.ts assertSafe 一致：拒绝含分隔符/`..`/空，从而挡路径穿越，
 * 同时允许项目里既有的中文 slug（如 `格格` / `主项目`）。
 */
function assertSafeSlug(slug: string, label: string): void {
  if (
    !slug ||
    slug.includes("/") ||
    slug.includes("\\") ||
    slug.includes("..") ||
    slug.includes("\0")
  ) {
    throw new Error(`非法 ${label}：${slug}`);
  }
}

/** clientSlug/projectSlug → 规格目录（fde-copilot 的 clients/<c>/projects/<p>/），带穿越防护 */
function specDirFor(clientSlug: string, projectSlug: string): string {
  assertSafeSlug(clientSlug, "clientSlug");
  assertSafeSlug(projectSlug, "projectSlug");
  const clientsDir = config.watchDirs[0] ?? "../fde-copilot/clients";
  const base = path.isAbsolute(clientsDir) ? clientsDir : path.resolve(PROJECT_ROOT, clientsDir);
  const dir = path.join(base, clientSlug, "projects", projectSlug);
  // canonical-prefix 断言：解析后仍须落在 base 内（双保险，防绕过 slug 规则的编码穿越）
  const resolved = path.resolve(dir);
  const baseResolved = path.resolve(base);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
    throw new Error(`规格目录越界：${clientSlug}/${projectSlug}`);
  }
  return dir;
}

/**
 * repo 路径防护：repo 原样进 manifest → 成为 runTask 开 worktree、跑 coder、建 PR 的目标。
 * 设了 LOOP_REPO_ROOT 时强制 repo 落在其下（白名单根前缀）；未设则至少拒绝 `..` 穿越。
 */
function assertSafeRepo(repo: string): void {
  if (repo.includes("\0")) throw new Error(`非法 repo：${repo}`);
  // 远程仓：只接受 https://github.com/（挡任意 scheme / SSRF）。clone 落 job 本地目录，
  // 不涉本机路径穿越，故跳过下面的本地路径白名单校验。
  if (isRemoteRepo(repo)) {
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+/i.test(repo)) {
      throw new Error(`远程 repo 仅支持 https://github.com/<owner>/<repo>：${repo}`);
    }
    return;
  }
  const root = process.env.LOOP_REPO_ROOT;
  if (root) {
    const rootResolved = path.resolve(root);
    const repoResolved = path.resolve(repo);
    if (repoResolved !== rootResolved && !repoResolved.startsWith(rootResolved + path.sep)) {
      throw new Error(`repo 越界(不在 LOOP_REPO_ROOT 下)：${repo}`);
    }
  } else if (repo.split(/[\\/]/).includes("..")) {
    throw new Error(`repo 含路径穿越：${repo}`);
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

// 冷启动可安全恢复的状态：非「运行中」的都可原样恢复
const RESTART_SAFE = new Set<JobState>(["queued", "done", "failed"]);

/**
 * 从磁盘补齐 registry（server 重启后 /run /status 仍能定位已 plan 过的 job）。
 * 优先读持久化快照(C1)拿真实状态 + prUrl/appUrl;无快照则从 loop.json 粗略推断。
 * 冷启动 reconcile：快照里「运行中」的状态(planning/coding/reviewing)必是被重启打断的
 * ——进程已死、没有在跑，标 failed(可 /run 重跑),避免永久卡在 coding。
 */
async function findJobRecord(jobId: string): Promise<JobRecord | undefined> {
  const cached = registry.get(jobId);
  if (cached) return cached;
  const jobs = await scanJobs(config.watchDirs);
  const job = jobs.find((j) => j.manifest.id === jobId);
  if (!job) return undefined;
  const { clientSlug, projectSlug } = clientProjectFromSpecDir(job.jobDir);

  const snap = await readStatus(job.jobDir);
  const rec: JobRecord = {
    jobId,
    specDir: job.jobDir,
    repo: job.manifest.repo,
    clientSlug,
    projectSlug,
    state: deriveState(job),
    updatedAt: new Date().toISOString(),
    usage: { ...ZERO },
    phases: [],
    gen: 0,
  };
  if (snap) {
    const snapState = snap.state as JobState;
    if (RESTART_SAFE.has(snapState)) {
      rec.state = snapState;
    } else {
      // 运行中被重启打断
      rec.state = "failed";
      rec.error = `server 重启,原状态「${snap.state}」的运行已中断(可重跑)`;
    }
    rec.prUrl = snap.prUrl;
    rec.appUrl = snap.appUrl;
    if (rec.state === "failed" && !rec.error) rec.error = snap.error;
    rec.updatedAt = snap.updatedAt;
    // Fix B：回读成本/分节明细,让重启后 /status 仍显示每步花费(不重置为 0)。
    if (snap.usage) rec.usage = { ...ZERO, ...snap.usage };
    if (snap.phases) rec.phases = snap.phases;
  }
  registry.set(jobId, rec);
  return rec;
}

/** 从磁盘 job 的任务状态粗略推断一个 rest 状态（server 冷启动时用） */
function deriveState(job: LoadedJob): JobState {
  const tasks = job.manifest.tasks;
  if (tasks.length === 0) return "queued";
  if (tasks.some((t) => t.status === "failed")) return "failed";
  if (tasks.every((t) => t.status === "done")) return "done";
  return "queued";
}

// —— 路由 ——
/**
 * POST /genspec —— 共享 spec-gen(CC-69):两前端(fde-copilot/hack5)调同一个端点,把对话/一句话需求
 * 生成结构化 loop-ready 的 SPEC.md + readiness。无状态:前端传状态进来、拿更新后的 spec 回去存盘/展示。
 * body: { input, currentSpec?, clientContext?, deliverableContext?, history?, lang? }
 * → { reply, openQuestions, readiness{score,loop_ready,missing}, spec_markdown, usage }
 */
async function handleGenSpec(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const input = String(body.input ?? "");
  if (!input.trim()) {
    send(res, 400, { error: "缺少 input（客户输入 / 一句话需求）" });
    return;
  }
  // pr-daemon #79:各字段大小上限,别把无界 payload 送进 LLM(成本/超时/滥用防护)。
  const currentSpec = typeof body.currentSpec === "string" ? body.currentSpec : undefined;
  const history = typeof body.history === "string" ? body.history : undefined;
  const clientContext = typeof body.clientContext === "string" ? body.clientContext : undefined;
  const deliverableContext = typeof body.deliverableContext === "string" ? body.deliverableContext : undefined;
  const tooBig =
    input.length > 64 * 1024 ||
    (currentSpec?.length ?? 0) > 512 * 1024 ||
    (history?.length ?? 0) > 128 * 1024 ||
    (clientContext?.length ?? 0) > 32 * 1024 ||
    (deliverableContext?.length ?? 0) > 8 * 1024;
  if (tooBig) {
    send(res, 400, {
      error: "请求体过大（上限：input 64KB / currentSpec 512KB / history 128KB / clientContext 32KB / deliverableContext 8KB）",
    });
    return;
  }
  try {
    const out = await genSpec(
      { input, currentSpec, clientContext, deliverableContext, history, lang: typeof body.lang === "string" ? body.lang : undefined },
      config,
    );
    send(res, 200, out);
  } catch (e) {
    log.err(`spec-gen 失败：${(e as Error).message}`);
    send(res, 500, { error: `spec-gen 失败：${(e as Error).message}` });
  }
}

async function handlePlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const clientSlug = String(body.clientSlug ?? "");
  const projectSlug = String(body.projectSlug ?? "");
  const repo = String(body.repo ?? "");
  if (!clientSlug || !projectSlug || !repo) {
    send(res, 400, { error: "缺少 clientSlug / projectSlug / repo" });
    return;
  }
  // 输入校验（slug 穿越防护 + repo 白名单）→ 非法一律 400，不落到 500
  let specDir: string;
  try {
    specDir = specDirFor(clientSlug, projectSlug);
    assertSafeRepo(repo);
  } catch (e) {
    send(res, 400, { error: (e as Error).message });
    return;
  }
  // 内联规格来源（CC-69 契约,fde-copilot 与 hack5 两个独立前端统一遵守）：
  // loop 与前端是**独立容器、读不到对方文件系统**（CC-58 拆分后的回归根因）,所以规格必须随 /plan 内联。
  // 三选一容错自愈,优先级从高到低:
  //   1) spec         —— 现成 markdown 规格,直接写 SPEC.md
  //   2) idea / conversation —— 前端的对话记录/一句话需求;没生成 spec 也能据此建,planner 会据此拆任务
  // 都没有且本地无预置规格 → 404 并明确指引前端内联。**幂等**:同 projectSlug 重复调用覆盖 SPEC.md 重建。
  const spec = typeof body.spec === "string" ? body.spec : undefined;
  const idea =
    typeof body.idea === "string"
      ? body.idea
      : typeof body.conversation === "string"
        ? body.conversation
        : undefined;
  let specSource: string | undefined;
  if (spec !== undefined && spec.trim().length > 0) {
    specSource = spec;
  } else if (idea !== undefined && idea.trim().length > 0) {
    specSource = `# 需求规格 · Spec（由前端对话/idea 自动生成 · CC-69 容错）\n\n${idea.trim()}\n`;
  }
  if (specSource !== undefined) {
    if (specSource.length > 512 * 1024) {
      send(res, 400, { error: "spec/idea 过大（上限 512KB）" });
      return;
    }
    try {
      await fs.mkdir(specDir, { recursive: true });
      await fs.writeFile(
        path.join(specDir, "SPEC.md"),
        specSource.endsWith("\n") ? specSource : specSource + "\n",
        "utf8",
      );
    } catch (e) {
      send(res, 500, { error: `写入 spec 失败：${(e as Error).message}` });
      return;
    }
  }
  if (!(await exists(specDir))) {
    send(res, 404, {
      error:
        `规格目录不存在且未内联规格来源：${specDir}。请在 /plan body 内联 spec:<markdown 全文> ` +
        `或 idea:<对话记录/一句话需求> 之一（loop 与前端是独立容器,读不到前端文件系统,故规格须随请求带上）。`,
    });
    return;
  }

  // B1：/plan 入队秒返回,不同步跑 planSpec（planner 分钟级,会让 hack5 的 CF Worker 超时 502）。
  // jobId 确定可复现 = projectSlug（manifest.id = basename(specDir) = projectSlug）。
  // 真正的拆规格 planSpec 由后台 job 先跑(needsPlan),再跑任务闭环,进度/结果走 /status + 回调。
  const jobId = projectSlug;
  const rec: JobRecord = {
    jobId,
    specDir,
    repo,
    clientSlug,
    projectSlug,
    state: "planning",
    needsPlan: true,
    updatedAt: new Date().toISOString(),
    usage: { ...ZERO },
    phases: [],
    gen: 0,
  };
  registry.set(jobId, rec);
  void persist(rec);
  enqueue(jobId); // 后台:planSpec → 任务闭环
  send(res, 200, { jobId });
}

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const jobId = String(body.jobId ?? "");
  if (!jobId) {
    send(res, 400, { error: "缺少 jobId" });
    return;
  }
  const rec = await findJobRecord(jobId);
  if (!rec) {
    send(res, 404, { error: `job 不存在：${jobId}` });
    return;
  }
  // 契约 v2 · B1：入队语义，返回 {accepted, jobId, queuePos}。queuePos=0 表示正在跑。
  if (pool.isRunning(jobId)) {
    send(res, 200, { accepted: true, jobId, queuePos: 0 });
    return;
  }
  if (!pool.isActive(jobId)) {
    setState(rec, "queued");
    enqueue(jobId);
  }
  send(res, 200, { accepted: true, jobId, queuePos: pool.queuePos(jobId) });
}

/** fde-copilot 产出的规格文档集（供 /spec 输出：hack5/作品墙可看「基于哪些规格在开发」）。 */
const SPEC_DOC_FILES = ["SPEC.md", "PRODUCT.md", "FEATURES.md", "TECH_SPEC.md", "INTERACTIONS.md", "GAPS.md"];

/** 从 loop.json 算任务级进度（总数/已完成/百分比/当前任务/任务清单）。未拆规格返回 null。 */
async function jobProgress(specDir: string): Promise<{
  total: number;
  done: number;
  percent: number;
  current: { id: string; title: string; status: string; attempts: number } | null;
  tasks: Array<{ id: string; title: string; status: string }>;
} | null> {
  const job = await loadJob(path.join(specDir, "loop.json"));
  if (!job || job.manifest.tasks.length === 0) return null;
  const tasks = job.manifest.tasks;
  const done = tasks.filter((t) => t.status === "done").length;
  const cur =
    tasks.find((t) => t.status === "in_progress") ?? tasks.find((t) => t.status === "todo") ?? null;
  return {
    total: tasks.length,
    done,
    percent: Math.round((done / tasks.length) * 100),
    current: cur ? { id: cur.id, title: cur.title, status: cur.status, attempts: cur.attempts } : null,
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
  };
}

async function handleStatus(res: ServerResponse, jobId: string): Promise<void> {
  const rec = await findJobRecord(jobId);
  if (!rec) {
    send(res, 404, { error: `job 不存在：${jobId}` });
    return;
  }
  // 任务级进度：让调用方(hack5/作品墙)看到「几个任务、做到第几个、百分比」而非只有粗状态。
  const progress = await jobProgress(rec.specDir).catch(() => null);
  send(res, 200, {
    state: rec.state,
    ...(progress
      ? {
          progress: {
            total: progress.total,
            done: progress.done,
            percent: progress.percent,
            current: progress.current,
          },
          tasks: progress.tasks,
        }
      : {}),
    // CC-54：实时累计成本(截至当前已完成的 planning+任务)
    costUsd: rec.usage.costUsd,
    inputTokens: rec.usage.inputTokens,
    outputTokens: rec.usage.outputTokens,
    // Fix B：分节明细(每步花多少/积分/卡点),前端可实时展示;失败/成功回调也带同结构。
    ...(rec.phases.length ? { phases: rec.phases } : {}),
    ...(rec.prUrl ? { prUrl: rec.prUrl } : {}),
    ...(rec.appUrl ? { appUrl: rec.appUrl } : {}),
    ...(rec.error ? { error: rec.error } : {}),
  });
}

/**
 * GET /spec/:jobId —— 输出该 job 正在基于哪些规格文档开发（SPEC.md 全文 + 其它规格文档 +
 * planner 拆出的任务清单）。让 hack5/作品墙能展示「AI 基于这份规格在做，做到哪一步」。
 */
async function handleSpec(res: ServerResponse, jobId: string): Promise<void> {
  const rec = await findJobRecord(jobId);
  if (!rec) {
    send(res, 404, { error: `job 不存在：${jobId}` });
    return;
  }
  const docs: Record<string, string> = {};
  for (const f of SPEC_DOC_FILES) {
    try {
      docs[f] = await fs.readFile(path.join(rec.specDir, f), "utf8");
    } catch {
      /* 缺文件跳过 */
    }
  }
  const job = await loadJob(path.join(rec.specDir, "loop.json")).catch(() => null);
  send(res, 200, {
    spec: docs["SPEC.md"] ?? "",
    docs,
    tasks:
      job?.manifest.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        spec: t.spec,
        acceptance: t.acceptance,
        status: t.status,
        dependsOn: t.dependsOn,
      })) ?? [],
  });
}

/**
 * POST /deploy { clientSlug, projectSlug, repo } → { appUrl, expiresAt, selfDeployHint }
 * 参赛者「一键部署」：clone 作品仓 → 部署到 CF Pages(内置账号)→ 发 deployed 回调 → 7 天自动删。
 */
async function handleDeploy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const clientSlug = String(body.clientSlug ?? "");
  const projectSlug = String(body.projectSlug ?? "");
  const repo = String(body.repo ?? "");
  if (!clientSlug || !projectSlug || !repo) {
    send(res, 400, { error: "缺少 clientSlug / projectSlug / repo" });
    return;
  }
  try {
    assertSafeSlug(clientSlug, "clientSlug");
    assertSafeSlug(projectSlug, "projectSlug");
    assertSafeRepo(repo);
  } catch (e) {
    send(res, 400, { error: (e as Error).message });
    return;
  }
  if (!isRemoteRepo(repo)) {
    send(res, 400, { error: "部署仅支持远程 GitHub 仓" });
    return;
  }
  const cf = cfCreds();
  if (!cf) {
    send(res, 501, { error: "未配置 CF Pages 部署凭据(PAGES_CF_TOKEN_THAI_TEA / THAI_TEA_CLIENT_ID)" });
    return;
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wb-deploy-"));
  try {
    await ensureClone(repo, path.join(tmp, "repo"), "main", loopPushToken());
    // 部署前构建:框架项目(有 build 脚本)→ install+build → 部署产物目录;纯静态 → 原目录。
    const build = await buildIfNeeded(path.join(tmp, "repo"));
    const result = await deployStaticDir(build.deployDir, clientSlug, projectSlug, cf, build.requiresNodejsCompat ?? false);
    // 发 deployed 回调(带 appUrl),hack5 翻徽章 + 展示在线链接
    await emitLifecycle({ event: "deployed", clientSlug, projectSlug, repo, appUrl: result.appUrl });
    send(res, 200, { ...result, built: build.built, ...(build.note ? { buildNote: build.note } : {}) });
  } catch (e) {
    log.err(`部署失败(${clientSlug}/${projectSlug})：${(e as Error).message}`);
    send(res, 500, { error: `部署失败：${(e as Error).message}` });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function router(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // B3：授权 origin 门禁（带 Origin 的浏览器跨站请求须落白名单；服务端调用无 Origin 放行）。
  if (!checkOrigin(req)) {
    send(res, 403, { error: "forbidden：origin 未授权" });
    return;
  }
  if (!checkWorkbenchToken(req)) {
    send(res, 401, { error: "未授权：需要有效的 x-workbench-token" });
    return;
  }
  // CC-69 容错:折叠重复斜杠 + 去尾斜杠再路由。hack5 的 WORKBENCH_LOOP_URL 尾部带 `/` 时会发出
  // `//plan` / `/plan/`,精确匹配 `p === "/plan"` 落空 → 带好 token 也 404(而 /estimate 走另一条
  // 干净构造不受影响,造成"同 host 同 token 唯独 /plan 404"的迷惑现象)。规范化后无论调用方怎么拼都通。
  // 关键:routePath 不经 `new URL`(它会把 `//plan` 当协议相对 URL,host 变 "plan"、pathname 变 "/",
  // 双斜杠就漏了),直接从 req.url 剥掉 query/fragment 再折叠斜杠。见 routing.ts。
  const p = routePath(req.url ?? "/");
  if (req.method === "POST" && p === "/estimate") return handleEstimate(req, res);
  if (req.method === "POST" && p === "/genspec") return handleGenSpec(req, res);
  if (req.method === "POST" && p === "/plan") return handlePlan(req, res);
  if (req.method === "POST" && p === "/run") return handleRun(req, res);
  if (req.method === "POST" && p === "/deploy") return handleDeploy(req, res);
  if (req.method === "GET" && p.startsWith("/status/")) {
    return handleStatus(res, decodeURIComponent(p.slice("/status/".length)));
  }
  if (req.method === "GET" && p.startsWith("/spec/")) {
    return handleSpec(res, decodeURIComponent(p.slice("/spec/".length)));
  }
  send(res, 404, { error: "未知路由" });
}

export async function startServer(port: number, host: string): Promise<void> {
  config = await loadConfig();
  installCallbackSink(); // W5：把 HMAC 签名回调挂到 lifecycle（coding_done 等事件外发给 hack5）

  // 一键部署的 7 天自动清理：每 6h 扫一次删过期 wb-* Pages 项目;启动 60s 后先跑一次。
  if (cfCreds()) {
    const runCleanup = () =>
      cleanupExpiredPages(7).catch((e) => log.warn(`Pages 清理失败：${(e as Error).message}`));
    setInterval(runCleanup, 6 * 60 * 60 * 1000).unref();
    setTimeout(runCleanup, 60_000).unref();
  }
  const server = createServer((req, res) => {
    router(req, res).catch((e) => {
      log.err(`请求处理异常：${(e as Error).message}`);
      if (!res.headersSent) send(res, 500, { error: (e as Error).message });
    });
  });
  server.listen(port, host, () => {
    log.ok(`Loop-Engineer HTTP 编排 API 已启动：http://${host}:${port}`);
    if (!process.env.WORKBENCH_TOKEN) {
      log.warn("未设置 WORKBENCH_TOKEN —— 所有请求都会被拒（fail-closed）。请在 .env 配置。");
    }
  });
}

// 直接运行入口
loadEnv();
const port = Number(process.env.LOOP_HTTP_PORT ?? 4050);
const host = process.env.LOOP_HTTP_HOST ?? "127.0.0.1";
startServer(port, host).catch((e) => {
  log.err(e.stack ?? String(e));
  process.exit(1);
});
