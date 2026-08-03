import { NextResponse } from "next/server";
import { readClient, readProjectState, readAllDocs, readConversation, ensureProjectWorkset } from "@/lib/clients";
import { scopedAuthError } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ client: string; project: string }> },
) {
  const { client, project } = await params;
  // B3：参赛者可用作用域 token 读自己的项目；越权读他人项目 → 403
  const denied = scopedAuthError(req, client, project);
  if (denied) return denied;
  const [c, state] = await Promise.all([readClient(client), readProjectState(client, project)]);
  if (!c || !state) return NextResponse.json({ error: "客户或项目不存在" }, { status: 404 });
  // CC-77：冷启后盘上没有工作集时先从 store 备份恢复，否则这里会静默返回空 docs/conversation
  // （UI 看着就像项目从没写过东西）。恢复不了 → 不铺模板，把 lost 如实回给 UI 展示。
  // 恢复**失败**（store 不可达等）必须报出来：吞成 present 会让 UI 拿到空 docs 却毫无异常信号 ——
  // 又是一次「静默白板」。注意本路由不进 withProjectLock：chat 的锁要持有整轮（可能几分钟），
  // 详情读不该被它堵死；与 chat 并发时最坏是两边各恢复一次同样的内容，幂等无害。
  let ws;
  try {
    ws = await ensureProjectWorkset(client, project);
  } catch (e) {
    return NextResponse.json(
      { error: `工作集恢复失败：${(e as Error).message}`, code: "workset_restore_failed" },
      { status: 503 },
    );
  }
  const [docs, conversation] = await Promise.all([
    readAllDocs(client, project),
    readConversation(client, project),
  ]);
  return NextResponse.json({
    client: c,
    state,
    docs,
    conversation,
    workset: ws.kind === "present" || ws.kind === "fresh" ? undefined : ws,
  });
}
