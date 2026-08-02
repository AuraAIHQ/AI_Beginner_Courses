import { NextResponse } from "next/server";
import { readProjectState, ensureProjectWorkset } from "@/lib/clients";
import { commitProject, assertAllowedPushHost } from "@/lib/git";
import { authError } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const denied = authError(req);
  if (denied) return denied;
  const { clientSlug, projectSlug, push, repo, pushToken } = (await req.json()) as {
    clientSlug?: string;
    projectSlug?: string;
    push?: boolean;
    repo?: string; // W2：目标公有仓库远程 URL
    pushToken?: string; // W2：hack5 注入的仓库级短时效 token（可选，也可走 env）
  };
  if (!clientSlug || !projectSlug) {
    return NextResponse.json({ error: "缺少 clientSlug / projectSlug" }, { status: 400 });
  }
  // #1：目标仓库 host 白名单，非法 host 直接 400（不落到 push 逻辑）
  if (repo) {
    try {
      assertAllowedPushHost(repo);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }
  const state = await readProjectState(clientSlug, projectSlug);
  if (!state) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  // CC-77：与 /api/chat 同一共享入口。冷启后盘丢了 → 先从备份恢复真内容再提交；
  // 恢复不了绝不 acceptLoss —— 对一个空壳工作集 commit+push 会把空模板推上去覆盖已交付的 spec。
  const ws = await ensureProjectWorkset(clientSlug, projectSlug);
  if (ws.kind === "lost") {
    return NextResponse.json(
      {
        error:
          `工作集已丢失：本项目有 ${ws.rounds} 轮历史，但容器重启后本地文档没了且无备份可恢复。` +
          `此时提交只会把空模板推上去、覆盖仓库里已交付的 spec，故拒绝。`,
        code: "workset_lost",
        rounds: ws.rounds,
      },
      { status: 409 },
    );
  }
  try {
    const r = await commitProject(
      clientSlug,
      projectSlug,
      `docs(${clientSlug}/${projectSlug}): 手动提交 spec（第 ${state.rounds} 轮）`,
      { push: push === true, repo, pushToken },
    );
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
