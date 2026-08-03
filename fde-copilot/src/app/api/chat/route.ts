import { NextResponse } from "next/server";
import {
  readProjectState,
  writeProjectState,
  appendConversation,
  ensureProjectWorkset,
  snapshotWorkset,
  withProjectLock,
  conversationSize,
  truncateConversation,
} from "@/lib/clients";
import { runTurn } from "@/lib/agent";
import { commitProject, type CommitResult } from "@/lib/git";
import { scopedAuthError, originError } from "@/lib/auth";
import { normLang } from "@/lib/agent";
import { addUsage, ZERO_USAGE } from "@/lib/types";

export const runtime = "nodejs";
// agent 单轮可能较久（调研 + 多文件写入）
export const maxDuration = 800;

export async function POST(req: Request) {
  // B3：origin 门禁抢在 body 解析之前（scopedAuthError 需 body 里的 client/project，排在后面；
  // 未授权域不该先进到 body 校验拿 400）。
  const oe = originError(req);
  if (oe) return oe;

  const { clientSlug, projectSlug, input, attachments, lang, acceptWorksetLoss } = (await req.json()) as {
    clientSlug?: string;
    projectSlug?: string;
    input?: string;
    attachments?: string[];
    lang?: string; // CC-53：zh | en | th，缺省 zh；非法值归一到 zh
    /** CC-77：工作集丢失且无备份时，用户确认「就从空白重来」的显式开关（见下方 409）。 */
    acceptWorksetLoss?: boolean;
  };

  if (!clientSlug || !projectSlug || !input || !input.trim()) {
    return NextResponse.json({ error: "缺少 clientSlug / projectSlug / input" }, { status: 400 });
  }

  // B3：参赛者会话用作用域 token（或 admin 全通）；越权访问他人项目 → 403
  const denied = scopedAuthError(req, clientSlug, projectSlug);
  if (denied) return denied;

  // 同项目串行(review #85):rounds/usage 是 read-modify-write,并发两轮会互相覆盖 → 少记一轮 +
  // 漏账;工作集备份同样是「读全量 → 重算末块 → 写回」,并发下较早请求的 stale 末块会盖掉较晚的。
  // 整段临界区(读 state → 跑一轮 → 写 state → 备份)必须在同一把锁内。
  return withProjectLock(clientSlug, projectSlug, () => runChatTurn(clientSlug, projectSlug, input.trim(), attachments, lang, acceptWorksetLoss === true));
}

async function runChatTurn(
  clientSlug: string,
  projectSlug: string,
  input: string,
  attachments: string[] | undefined,
  lang: string | undefined,
  acceptWorksetLoss: boolean,
): Promise<NextResponse> {
  const state = await readProjectState(clientSlug, projectSlug);
  if (!state) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  // 冷启动水合(review #85):D1 有 state 但容器盘丢了 projectDir → 先从 store 备份恢复真内容,
  // 否则下面 appendConversation / runTurn 的 fs 写会 ENOENT 500(且吃不到 state.usage 更新)。
  // 恢复不了(老项目无备份)绝不静默铺白板 —— 那会让 agent 在零上文下继续跑、rounds 继续加在
  // 已被抹掉的历史上,而用户毫无信号。此时响亮 409,由用户决定是否从空白重来。
  let ws;
  try {
    ws = await ensureProjectWorkset(clientSlug, projectSlug, { acceptLoss: acceptWorksetLoss });
  } catch (e) {
    // 恢复过程本身失败（store 不可达 / 写盘失败）→ 503，绝不当成「盘上本来就没东西」继续跑。
    return NextResponse.json(
      { error: `工作集恢复失败，请稍后重试：${(e as Error).message}`, code: "workset_restore_failed" },
      { status: 503 },
    );
  }
  if (ws.kind === "lost") {
    return NextResponse.json(
      {
        error: ws.localDirty
          ? `工作集处于脏状态且清理失败：上一轮失败后需要撤销的那条输入没能从磁盘上清掉（容器磁盘异常）。` +
            `继续对话会把这条已撤销的输入当成历史喂给 agent。这不是确认一下就能绕过的 —— 需要等容器重启` +
            `（重启后本地盘会重建并从备份恢复）或联系运维处理。本地开发环境请手工删除项目目录下的 ` +
            `.workset-dirty 与脏 conversation.jsonl。`
          : ws.staleSince
          ? `工作集已丢失，且备份已过期：本项目有 ${ws.rounds} 轮历史，最后一次备份失败于 ${ws.staleSince}，` +
            `store 里那份比现在落后至少一轮。直接恢复会把你悄悄退回更早的版本。确认接受，请带 ` +
            `acceptWorksetLoss: true 重发（届时文档恢复到更早一轮，会话历史不恢复）。`
          : `工作集已丢失：本项目在服务端有 ${ws.rounds} 轮历史，但容器重启后本地文档与会话没了，` +
            `且没有可恢复的备份（该项目建于备份机制上线之前，或备份不完整）。继续对话会在空白上下文上重来，` +
            `此前的会话不会回来。确认要继续，请带 acceptWorksetLoss: true 重发本请求（文档若有备份仍会恢复）；` +
            `此前生成的文档也可到 git 交付仓库找回。`,
        code: "workset_lost",
        rounds: ws.rounds,
        staleSince: ws.staleSince,
      },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  // 回滚点：agent 挂了就把这条客户输入撤掉，否则用户重试后历史里会留下两条一样的输入，
  // 而且下一轮 agent 还会把这段脏历史当上下文。持锁中，截断不会误伤并发请求。
  const rollbackTo = await conversationSize(clientSlug, projectSlug);
  await appendConversation(clientSlug, projectSlug, {
    role: "customer",
    at: now,
    text: input,
    attachments,
  });

  let out;
  try {
    out = await runTurn({ clientSlug, projectSlug, customerInput: input, attachments, lang: normLang(lang) });
  } catch (e) {
    const rolled = await truncateConversation(clientSlug, projectSlug, rollbackTo);
    if (!rolled.ok) {
      // 本地回滚了但备份没跟上：store 里还留着这条已撤销的输入，而 state 仍认为备份可信 →
      // 容器重启后会被当成历史恢复回来。标脏，让 ensureProjectWorkset 拒绝信任这份备份。
      try {
        await writeProjectState({ ...state, worksetBackupDirtyAt: new Date().toISOString() });
      } catch (e2) {
        console.error(`[workset] ${clientSlug}/${projectSlug} 标脏也失败：${(e2 as Error).message}`);
      }
    }
    return NextResponse.json({ error: `agent 执行失败：${(e as Error).message}` }, { status: 500 });
  }

  await appendConversation(clientSlug, projectSlug, {
    role: "copilot",
    at: new Date().toISOString(),
    text: out.result.reply,
    result: out.result,
  });

  // 文档由 agent 直接写盘 → 轮末整份镜像进 store，下次冷启才恢复得出真内容（而非空模板）。
  // **必须在 writeProjectState 之后**：备份失败不该连累这一轮的 rounds/usage 落账 —— agent 已经跑完、
  // 钱已经花了，此时 500 会让计费永久丢失（正是本 PR 要修的那类问题）。备份失败改为标脏 + 告警。
  const nextStatus =
    out.result.readiness.loop_ready ? "ready" : state.status === "intake" ? "building" : state.status;
  const nextState = {
    ...state,
    updatedAt: new Date().toISOString(),
    rounds: state.rounds + 1,
    status: nextStatus,
    lastReadiness: out.result.readiness,
    usage: addUsage(state.usage ?? ZERO_USAGE, out.usage),
    // 历史断点的唯一durable记录：rounds 连续累加，光看 rounds 看不出中间断过一次。
    ...(ws.kind === "reset"
      ? { worksetLostAt: new Date().toISOString(), worksetLostAtRound: ws.rounds }
      : {}),
  };
  await writeProjectState(nextState);

  let backupFailed: string | null = null;
  try {
    await snapshotWorkset(clientSlug, projectSlug);
    // 备份成功 → 清掉可能存在的脏标记（上一轮失败、这一轮全量补写成功即自愈）。
    if (state.worksetBackupDirtyAt) {
      await writeProjectState({ ...nextState, worksetBackupDirtyAt: undefined });
    }
  } catch (e) {
    // 绝不静默：备份没成，这个项目当前就是「没有可信备份」，必须写进 state 并告诉用户，
    // 否则就成了「以为有备份其实没有」——比没有备份更危险。
    backupFailed = (e as Error).message;
    console.error(`[workset] ${clientSlug}/${projectSlug} 轮末备份失败：${backupFailed}`);
    try {
      await writeProjectState({ ...nextState, worksetBackupDirtyAt: new Date().toISOString() });
    } catch {
      /* state 也写不进去时只能靠日志 —— 这轮的 usage 已经落账，不再重试以免覆盖 */
    }
  }

  let commit: CommitResult | null = null;
  // 从空白重建的这一轮无条件不 commit/push（不看 env）：盘上是空模板，推上去会覆盖仓库里已交付的 spec。
  if (ws.kind !== "reset" && process.env.AUTO_COMMIT === "true") {
    try {
      commit = await commitProject(
        clientSlug,
        projectSlug,
        `docs(${clientSlug}/${projectSlug}): 第 ${state.rounds + 1} 轮 spec（readiness ${out.result.readiness.score}）`,
        { push: process.env.AUTO_PUSH === "true" },
      );
    } catch (e) {
      commit = { committed: false, pushed: false, detail: `提交失败：${(e as Error).message}` };
    }
  }

  return NextResponse.json({
    result: out.result,
    usedFallback: out.usedFallback,
    commit,
    // CC-77：工作集这轮是否发生过恢复/重建，供 UI 提示（present/fresh 时无需打扰用户）。
    workset: ws.kind === "present" || ws.kind === "fresh" ? undefined : ws,
    // 备份失败必须让用户看见：这轮结果保住了，但容器再重启就真丢了。
    worksetBackupFailed: backupFailed ?? undefined,
    // CC-54：回传本轮 chat 实际 token 成本(按价表算)供 hack5 积分扣费
    usage: {
      costUsd: out.usage.costUsd,
      inputTokens: out.usage.inputTokens,
      outputTokens: out.usage.outputTokens,
    },
  });
}
