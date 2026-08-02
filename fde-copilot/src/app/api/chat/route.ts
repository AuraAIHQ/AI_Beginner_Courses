import { NextResponse } from "next/server";
import { readProjectState, writeProjectState, appendConversation, ensureProjectWorkset } from "@/lib/clients";
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

  const { clientSlug, projectSlug, input, attachments, lang } = (await req.json()) as {
    clientSlug?: string;
    projectSlug?: string;
    input?: string;
    attachments?: string[];
    lang?: string; // CC-53：zh | en | th，缺省 zh；非法值归一到 zh
  };

  if (!clientSlug || !projectSlug || !input || !input.trim()) {
    return NextResponse.json({ error: "缺少 clientSlug / projectSlug / input" }, { status: 400 });
  }

  // B3：参赛者会话用作用域 token（或 admin 全通）；越权访问他人项目 → 403
  const denied = scopedAuthError(req, clientSlug, projectSlug);
  if (denied) return denied;

  const state = await readProjectState(clientSlug, projectSlug);
  if (!state) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  // 冷启动水合(review #85 blocking):D1 有 state 但容器盘丢了 projectDir → 补齐工作集,
  // 否则下面 appendConversation / runTurn 的 fs 写会 ENOENT 500(且吃不到 state.usage 更新)。
  await ensureProjectWorkset(clientSlug, projectSlug);

  const now = new Date().toISOString();
  await appendConversation(clientSlug, projectSlug, {
    role: "customer",
    at: now,
    text: input.trim(),
    attachments,
  });

  let out;
  try {
    out = await runTurn({ clientSlug, projectSlug, customerInput: input.trim(), attachments, lang: normLang(lang) });
  } catch (e) {
    return NextResponse.json({ error: `agent 执行失败：${(e as Error).message}` }, { status: 500 });
  }

  await appendConversation(clientSlug, projectSlug, {
    role: "copilot",
    at: new Date().toISOString(),
    text: out.result.reply,
    result: out.result,
  });

  const nextStatus =
    out.result.readiness.loop_ready ? "ready" : state.status === "intake" ? "building" : state.status;
  await writeProjectState({
    ...state,
    updatedAt: new Date().toISOString(),
    rounds: state.rounds + 1,
    status: nextStatus,
    lastReadiness: out.result.readiness,
    usage: addUsage(state.usage ?? ZERO_USAGE, out.usage),
  });

  let commit: CommitResult | null = null;
  if (process.env.AUTO_COMMIT === "true") {
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
    // CC-54：回传本轮 chat 实际 token 成本(按价表算)供 hack5 积分扣费
    usage: {
      costUsd: out.usage.costUsd,
      inputTokens: out.usage.inputTokens,
      outputTokens: out.usage.outputTokens,
    },
  });
}
