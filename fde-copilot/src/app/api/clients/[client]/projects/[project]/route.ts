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
  const ws = await ensureProjectWorkset(client, project).catch(() => ({ kind: "present" }) as const);
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
