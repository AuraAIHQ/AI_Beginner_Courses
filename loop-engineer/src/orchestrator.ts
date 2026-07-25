import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";
import { resolveProvider, resolveChatChain } from "./config.js";
import type { ResolvedProvider } from "./config.js";

/**
 * CC-58 fix（PR #57 review）：容错解析 reviewer 链。主 provider（如默认 workers-ai:...）在缺 CF
 * 凭证时 resolveProvider 会同步抛错——若不容错，这个抛错发生在 runChat 的 fallback 链介入之前，
 * "用尽即降级"完全失效（P4 部署前 reviewer 阶段稳定失败）。这里把主 provider 解析失败当作"该档不可用"
 * 跳过，从首个可解析的兜底档起，与 planner 的降级链对称。
 * 返回 null = 一个可用 provider 都没有（凭证全缺）→ 调用方按 task-failed 处理。
 */
function resolveReviewerChain(
  primaryName: string,
): { provider: ResolvedProvider; fallbacks: ResolvedProvider[] } | null {
  let primary: ResolvedProvider | null = null;
  try {
    primary = resolveProvider(primaryName);
  } catch {
    primary = null; // 主 provider 不可用（如 workers-ai 缺 CF 凭证）→ 走兜底链
  }
  // agentic reviewer（非 openai-chat）：无 chat 兜底链，单 provider 直用（能解析才有）
  if (primary && primary.kind !== "openai-chat") {
    return { provider: primary, fallbacks: [] };
  }
  // openai-chat（或主档不可用）：主档 + 角色兜底链，逐档跳过不可解析的
  const fallbacks = resolveChatChain(
    process.env.LOOP_REVIEWER_FALLBACK ?? "deepseek-chat,hilinkup:kimi-k2.7-code",
  );
  const chain = [...(primary ? [primary] : []), ...fallbacks];
  if (chain.length === 0) return null;
  return { provider: chain[0], fallbacks: chain.slice(1) };
}
import type { Config, LoadedJob, ReviewVerdict, Task } from "./types.js";
import { runAgent, runChat, extractJson } from "./providers.js";
import {
  ensureIntegrationWorktree,
  createTaskWorktree,
  removeWorktree,
  commitAll,
  hasChanges,
  mergeToIntegration,
  openPr,
  diffAgainst,
} from "./git.js";
import { runGate } from "./gate.js";
import { saveJob, appendJournal } from "./jobs.js";
import { reportBlocked } from "./feedback.js";
import { ZERO, add } from "./usage.js";
import type { Usage } from "./usage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS = path.resolve(__dirname, "..", "prompts");

async function prompt(name: string): Promise<string> {
  return fs.readFile(path.join(PROMPTS, name), "utf8");
}

function taskBlock(task: Task, integrationBranch: string): string {
  return [
    `- 任务 ID：${task.id}`,
    `- 标题：${task.title}`,
    `- 说明：${task.spec}`,
    `- 验收标准：\n${task.acceptance.map((a) => `    - ${a}`).join("\n") || "    （无）"}`,
    task.files.length ? `- 建议改动范围：${task.files.join(", ")}` : "",
    `- 集成分支（diff 基线）：${integrationBranch}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// —— mock 处理器（无 key 时跑通编排）——
function mockCoder(task: Task) {
  return async (_p: string, cwd: string): Promise<string> => {
    const f = path.join(cwd, `feature_${task.id}.txt`);
    await fs.writeFile(f, `mock implementation for ${task.id}: ${task.title}\n`, "utf8");
    return `[mock coder] 创建 feature_${task.id}.txt`;
  };
}
function mockReviewer(task: Task) {
  return async (): Promise<string> => {
    const v: ReviewVerdict = {
      approved: true,
      score: 90,
      blocking: [],
      suggestions: [],
      summary: `[mock reviewer] ${task.id} 通过`,
    };
    return JSON.stringify(v);
  };
}

export interface RunTaskResult {
  ok: boolean;
  status: Task["status"];
  detail: string;
  /** 尽力开成的 PR 链接（无 remote/gh 时为空） */
  prUrl?: string;
  /** 本任务累计用量（coder + 各 reviewer + 返工，CC-54 per-job 成本汇总用）。 */
  usage: Usage;
}

/** 阶段回调：供 HTTP 编排层（server.ts）把细粒度状态映射到 /status 契约 */
export interface RunTaskHooks {
  onPhase?: (phase: "coding" | "reviewing") => void;
  /** 外部取消信号（job 级超时）：abort 时终止编码/评审、kill 子进程 */
  signal?: AbortSignal;
}

/**
 * 跑单个任务的完整闭环：worktree → coder → gate → 跨模型 review → 返工(≤maxAttempts)
 * → PR(尽力) → 合并集成分支 → 标记 done。
 */
export async function runTask(
  job: LoadedJob,
  task: Task,
  config: Config,
  hooks?: RunTaskHooks,
): Promise<RunTaskResult> {
  const repo = job.repoPath;
  const integration = job.manifest.integrationBranch;
  let taskUsage: Usage = { ...ZERO }; // CC-54：本任务累计用量（coder + reviewer + 返工）
  // per-task 模型路由：任务可覆盖全局默认（难任务派更强的模型）。
  // 容错解析（PR #57 review）：coder 缺凭证时干净地标 task-failed，不抛未捕获异常。
  let coder: ResolvedProvider;
  try {
    coder = resolveProvider(task.coderProvider ?? config.providers.coder);
  } catch (e) {
    task.status = "failed";
    task.lastResult = `coder provider 解析失败：${(e as Error).message}`;
    log.err(`  ${task.lastResult}`);
    await saveJob(job);
    return { ok: false, status: "failed", detail: task.lastResult, usage: taskUsage };
  }
  if (!coder.capabilities.agenticCoder) {
    // agentic 编码需 Anthropic 端点/codex，或声明 agenticCoder 的 OpenAI-compatible（LM Studio）。
    // chat-only 网关（HiLinkup / openai-chat 云单发）不能直接驱动 claude -p。
    task.status = "failed";
    task.lastResult = `coder Provider(${coder.name})不具备 agenticCoder 能力`;
    log.err(`  ${task.lastResult}`);
    await saveJob(job);
    return { ok: false, status: "failed", detail: task.lastResult, usage: taskUsage };
  }
  // 评审面板：内层（快、便宜）+ 可选外层（如 deepseek，独立第二意见），双过才 merge。
  // reviewer 用容错链（主档缺凭证 → 降级到兜底，见 resolveReviewerChain），fallbacks 逐档 failover。
  const reviewerChain = resolveReviewerChain(task.reviewerProvider ?? config.providers.reviewer);
  if (!reviewerChain) {
    task.status = "failed";
    task.lastResult = "reviewer 无可用 provider（Workers AI / DeepSeek / HiLinkup 凭证全缺）";
    log.err(`  ${task.lastResult}`);
    await saveJob(job);
    return { ok: false, status: "failed", detail: task.lastResult, usage: taskUsage };
  }
  const reviewers: Array<{ tag: string; provider: ResolvedProvider; fallbacks: ResolvedProvider[] }> = [
    { tag: "内层", provider: reviewerChain.provider, fallbacks: reviewerChain.fallbacks },
  ];
  if (config.providers.outerReviewer) {
    // 外层 reviewer 解析失败不阻断主流程（它是可选第二意见）→ 跳过外层
    try {
      reviewers.push({ tag: "外层", provider: resolveProvider(config.providers.outerReviewer), fallbacks: [] });
    } catch (e) {
      log.warn(`  外层 reviewer 解析失败，跳过：${(e as Error).message}`);
    }
  }

  const integrationWt = await ensureIntegrationWorktree(repo, job.manifest.baseBranch, integration);
  const branch = `loop/${job.manifest.id}/${task.id}`;
  task.branch = branch;

  log.step(`任务 ${task.id} · ${task.title}`);
  await appendJournal(
    job,
    task.id,
    `开始（coder=${coder.name} reviewers=${reviewers.map((r) => r.provider.name).join("+")}）`,
  );

  const wt = await createTaskWorktree(repo, integration, branch);
  const tb = taskBlock(task, integration);
  const workerTpl = await prompt("worker.md");
  const reviewerTpl = await prompt("reviewer.md");

  let feedback = "";
  let success = false;
  let lastDetail = "";
  let prUrl: string | undefined;

  try {
    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      if (hooks?.signal?.aborted) throw new Error("job 超时，取消任务");
      task.attempts = attempt;
      hooks?.onPhase?.("coding");
      log.info(`  尝试 ${attempt}/${config.maxAttempts} · 编码中（${coder.name}）`);

      const workerPrompt = workerTpl
        .replace("{{TASK_BLOCK}}", tb)
        .replace("{{FEEDBACK_BLOCK}}", feedback || "（首轮，无返工反馈）");
      const coderRes = await runAgent(workerPrompt, {
        cwd: wt,
        provider: coder,
        signal: hooks?.signal,
        mockHandler: coder.isMock ? mockCoder(task) : undefined,
      });
      taskUsage = add(taskUsage, coderRes.usage);

      const committed = await commitAll(wt, `feat(${task.id}): ${task.title} [attempt ${attempt}]`);
      if (!committed && !(await hasChanges(wt))) {
        // 首轮就没产出任何改动 → 判 blocked
        if (attempt === 1) {
          lastDetail = "coder 未产生任何改动";
          await appendJournal(job, task.id, `⚠ ${lastDetail}`);
          break;
        }
      }

      // 质量闸
      log.info(`  质量闸（${job.manifest.verify.commands.length} 步）`);
      const gate = await runGate(wt, job.manifest.verify);
      if (!gate.passed) {
        feedback = `质量闸失败：\n${gate.failureLog}`;
        lastDetail = `质量闸失败（尝试 ${attempt}）`;
        log.warn(`  ${lastDetail} → 返工`);
        await appendJournal(job, task.id, `✗ 质量闸失败 → 返工`);
        continue;
      }

      // 跨模型评审面板（内层 + 可选外层），任一打回即返工
      hooks?.onPhase?.("reviewing");
      const reviewPrompt = reviewerTpl.replace("{{TASK_BLOCK}}", tb);
      // 评审 diff 预先算好，喂给两类 reviewer（agentic 也不必自己跑 git，从而可收成只读）
      const reviewDiff = await diffAgainst(wt, integration);
      // 单次评审调用（agentic 或 chat）；返回文本 + 用量（CC-54 成本汇总）
      const callReviewer = async (
        rp: (typeof reviewers)[number],
      ): Promise<{ text: string; usage: Usage }> => {
        // inline = 单发 chat（openai-chat 云单发 / openai-compatible 网关如 HiLinkup / 本地 LM Studio）
        if (rp.provider.capabilities.contextAccess === "inline") {
          const r = await runChat(
            "你是严格、对抗性的代码评审员。直接输出一个 JSON 对象，第一个字符就是 {，不要任何解释文字或 markdown。",
            `${reviewPrompt}\n\n${reviewDiff}`,
            // CC-58：reviewer 默认 Workers AI(kimi)，用尽即按容错链切 DeepSeek → HiLinkup(kimi)
            { provider: rp.provider, fallbacks: rp.fallbacks },
          );
          return { text: r.text, usage: r.usage };
        }
        const r = await runAgent(`${reviewPrompt}\n\n${reviewDiff}`, {
          cwd: wt,
          provider: rp.provider,
          signal: hooks?.signal,
          // reviewer 只读：只给检索工具，并硬禁写/命令（deny 优先于 skip-permissions）
          allowedTools: ["Read", "Grep", "Glob"],
          disallowedTools: ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"],
          mockHandler: rp.provider.isMock ? mockReviewer(task) : undefined,
        });
        return { text: r.text, usage: r.usage };
      };

      let panelPassed = true;
      for (const r of reviewers) {
        log.info(`  ${r.tag}评审（${r.provider.name}）`);
        // 解析重试：评审输出非 JSON 只是模型格式抖动，重试评审而非返工重编（省 token、防误判）
        let verdict: ReviewVerdict | null = null;
        let reviewErr: Error | null = null;
        for (let ri = 1; ri <= 2 && !verdict; ri++) {
          try {
            const rev = await callReviewer(r);
            taskUsage = add(taskUsage, rev.usage);
            verdict = extractJson<ReviewVerdict>(rev.text);
          } catch (e) {
            // 评审模型瞬时故障（如 HiLinkup 524 / 网络）——不是代码问题，别重试解析
            if (hooks?.signal?.aborted) throw e; // job 超时的 abort 要如实失败，不放行
            reviewErr = e as Error;
            break;
          }
          if (!verdict && ri < 2) log.warn(`  ${r.tag}评审输出非 JSON，重试解析(${ri}/2)`);
        }

        if (reviewErr) {
          // 评审模型调用失败（gate 已过、代码已写出）：别因「审不成」就判整个任务/ job 失败 →
          // 保守放行本层（与「裁决无法解析」同策）。真有质量问题留给外层 reviewer / 后续迭代。
          log.warn(`  ${r.tag}评审模型调用失败(${reviewErr.message.slice(0, 80)})，gate 已过→保守放行本层`);
          await appendJournal(job, task.id, `⚠ ${r.tag}评审模型故障(${reviewErr.message.slice(0, 60)})→放行`);
          continue;
        }
        if (!verdict) {
          // 两次都拿不到可解析裁决：保守放行本层（gate 已过），避免格式问题空转返工
          log.warn(`  ${r.tag}评审两次均无法解析，gate 已过，保守放行本层`);
          await appendJournal(job, task.id, `⚠ ${r.tag}评审输出无法解析，gate 已过→放行`);
          continue;
        }
        if (!verdict.approved) {
          feedback = `${r.tag}评审打回（score ${verdict.score}）：\n${verdict.blocking.map((b) => `- ${b}`).join("\n")}`;
          lastDetail = `${r.tag}评审打回：${verdict.summary}`;
          log.warn(`  ${lastDetail} → 返工`);
          await appendJournal(job, task.id, `✗ ${r.tag}评审打回：${verdict.summary}`);
          panelPassed = false;
          break;
        }
        log.ok(`  ${r.tag}评审通过（score ${verdict.score}）`);
      }
      if (!panelPassed) continue;

      // 全部评审通过
      success = true;
      lastDetail = `通过（${reviewers.length} 层评审）`;
      log.ok(`  ${lastDetail}`);
      break;
    }

    if (success) {
      // CC-63 P1 review(#71):被中止(job/task 超时后 runWithTimeout 放弃等待 → 本 fn 成孤儿)时,
      // **绝不再做 push/merge/标 done 这些不可逆副作用** —— 编排层可能已把该 job 判 failed 并发过
      // 终态 W5 回调。放弃等待 ≠ 取消运行,这里显式守卫 abort 才不会「已 failed 还偷偷 merge」。
      if (hooks?.signal?.aborted) {
        lastDetail = "任务已中止(超时),放弃回推/合并";
        task.status = "blocked";
        log.warn(`  ${lastDetail}`);
        await appendJournal(job, task.id, `⚠ ${lastDetail}`);
        return { ok: false, status: "blocked", detail: lastDetail, usage: taskUsage };
      }
      const pr = await openPr(
        repo,
        branch,
        integration,
        `loop(${task.id}): ${task.title}`,
        `自主编码循环完成任务 ${task.id}。\n\n${task.spec}\n\n验收：\n${task.acceptance.map((a) => `- ${a}`).join("\n")}`,
      );
      await mergeToIntegration(integrationWt, branch, `Merge ${branch}: ${task.title}`);
      prUrl = pr.url;
      task.status = "done";
      task.lastResult = `${lastDetail}；${pr.detail}`;
      log.ok(`  合并进 ${integration}；${pr.detail}`);
      await appendJournal(job, task.id, `✓ 完成并合并（${pr.opened ? pr.url : "本地集成"}）`);
    } else {
      task.status = task.attempts >= config.maxAttempts ? "failed" : "blocked";
      task.lastResult = lastDetail;
      log.err(`  任务未通过：${lastDetail}`);
      await appendJournal(job, task.id, `✗ 收工未通过：${lastDetail}`);
      // v0.2 失败回流：把技术失败翻译成面向客户的澄清问题，回写规格目录 GAPS.md
      try {
        await reportBlocked(job, task, `${lastDetail}\n\n${feedback}`, config);
      } catch (e) {
        log.warn(`  回流失败：${(e as Error).message}`);
      }
    }
  } finally {
    await removeWorktree(repo, wt);
    await saveJob(job);
  }

  return { ok: success, status: task.status, detail: lastDetail, prUrl, usage: taskUsage };
}
