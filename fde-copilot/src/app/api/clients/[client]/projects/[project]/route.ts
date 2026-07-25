import { NextResponse } from "next/server";
import { readClient, readProjectState, readAllDocs, readConversation, writeProjectState } from "@/lib/clients";
import { authError, scopedAuthError } from "@/lib/auth";
import type { ModelSelection } from "@/lib/types";

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
  const [docs, conversation] = await Promise.all([
    readAllDocs(client, project),
    readConversation(client, project),
  ]);
  return NextResponse.json({ client: c, state, docs, conversation });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ client: string; project: string }> },
) {
  const denied = authError(req);
  if (denied) return denied;
  const { client, project } = await params;
  const state = await readProjectState(client, project);
  if (!state) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  const { provider, model } = (await req.json()) as { provider?: string; model?: string };
  if (provider !== "claude" && provider !== "lmstudio") {
    return NextResponse.json({ error: "不支持的 Provider" }, { status: 400 });
  }
  const selection: ModelSelection = {
    provider,
    ...(model?.trim() ? { model: model.trim() } : {}),
  };
  const next = { ...state, model: selection, updatedAt: new Date().toISOString() };
  await writeProjectState(next);
  return NextResponse.json({ state: next });
}
