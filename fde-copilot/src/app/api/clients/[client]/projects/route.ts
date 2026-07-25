import { NextResponse } from "next/server";
import { listProjects, createProject, readClient } from "@/lib/clients";
import { authError } from "@/lib/auth";
import { DELIVERABLE_TYPES } from "@/lib/types";
import type { DeliverableType, ModelSelection } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ client: string }> }) {
  const denied = authError(req);
  if (denied) return denied;
  const { client } = await params;
  const c = await readClient(client);
  if (!c) return NextResponse.json({ error: "客户不存在" }, { status: 404 });
  const projects = await listProjects(client);
  return NextResponse.json({ client: c, projects });
}

export async function POST(req: Request, { params }: { params: Promise<{ client: string }> }) {
  const denied = authError(req);
  if (denied) return denied;
  const { client } = await params;
  try {
    const { name, deliverableName, deliverableType, provider, model } = (await req.json()) as {
      name?: string;
      deliverableName?: string;
      deliverableType?: string;
      provider?: string;
      model?: string;
    };
    if (!name || !name.trim()) return NextResponse.json({ error: "缺少项目名称" }, { status: 400 });
    const type = (DELIVERABLE_TYPES.find((d) => d.id === deliverableType)?.id ?? "other") as DeliverableType;
    const selection: ModelSelection | undefined = provider === "claude" || provider === "lmstudio"
      ? { provider, ...(model?.trim() ? { model: model.trim() } : {}) }
      : undefined;
    const project = await createProject(
      client,
      name.trim(),
      { name: (deliverableName ?? name).trim(), type },
      selection,
    );
    return NextResponse.json({ project }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
