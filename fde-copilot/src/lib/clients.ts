import { promises as fs } from "node:fs";
import path from "node:path";
import type { Client, ConversationEntry, Deliverable, ModelSelection, ProjectState } from "./types";
import { SPEC_DOCS } from "./types";

// clients/<client>/client.json + clients/<client>/projects/<project>/{docs,state,conversation}
export const CLIENTS_DIR = path.join(process.cwd(), "clients");

export function slugify(name: string): string {
  const base = name
    .trim().toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `x-${Date.now()}`;
}

function assertSafe(slug: string): void {
  if (typeof slug !== "string" || !slug || slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new Error(`非法标识：${String(slug)}`);
  }
}

export function clientDir(clientSlug: string): string {
  assertSafe(clientSlug);
  const dir = path.join(CLIENTS_DIR, clientSlug);
  const resolved = path.resolve(dir);
  if (resolved !== CLIENTS_DIR && !resolved.startsWith(CLIENTS_DIR + path.sep)) {
    throw new Error(`客户目录越界：${clientSlug}`);
  }
  return dir;
}

export function projectDir(clientSlug: string, projectSlug: string): string {
  assertSafe(projectSlug);
  const base = path.join(clientDir(clientSlug), "projects");
  const dir = path.join(base, projectSlug);
  if (!path.resolve(dir).startsWith(path.resolve(base) + path.sep)) {
    throw new Error(`项目目录越界：${projectSlug}`);
  }
  return dir;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

// —— 客户 ——
export async function listClients(): Promise<Client[]> {
  if (!(await exists(CLIENTS_DIR))) return [];
  const entries = await fs.readdir(CLIENTS_DIR, { withFileTypes: true });
  const out: Client[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const c = await readClient(e.name);
    if (c) out.push(c);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readClient(clientSlug: string): Promise<Client | null> {
  let dir: string;
  try { dir = clientDir(clientSlug); } catch { return null; }
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "client.json"), "utf8")) as Client;
  } catch {
    return null;
  }
}

export async function writeClient(c: Client): Promise<void> {
  const dir = clientDir(c.slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "client.json"), JSON.stringify(c, null, 2), "utf8");
}

export async function createClient(name: string, background: string): Promise<Client> {
  const slug = slugify(name);
  if (await exists(path.join(clientDir(slug), "client.json"))) {
    throw new Error(`客户「${slug}」已存在`);
  }
  const now = new Date().toISOString();
  const c: Client = { slug, name, background: background.trim(), createdAt: now, updatedAt: now };
  await writeClient(c);
  await fs.mkdir(path.join(clientDir(slug), "projects"), { recursive: true });
  return c;
}

// —— 项目 ——
function docScaffold(clientName: string, projectName: string, deliverable: Deliverable, now: string): Record<string, string> {
  const head = (title: string, hint: string) =>
    `# ${title}\n\n> 客户：${clientName} ｜ 项目：${projectName} ｜ 交付物：${deliverable.name}（${deliverable.type}）\n> ${hint}\n> 本文件由 FDE Copilot 随每轮对话自动维护。\n\n_（尚未开始，等待输入）_\n`;
  return {
    "SPEC.md": head("需求规格 · Spec", "问题定义 / 目标 / 范围 / 成功指标 / 非目标"),
    "PRODUCT.md": head("产品描述 · Product", "一句话定位 / 目标用户 / 核心价值 / 关键场景"),
    "FEATURES.md": head("Feature 细节", "用户故事 + 验收标准 + 边界/异常 + 优先级"),
    "TECH_SPEC.md": head("技术方案 · Tech Spec", "架构 / 数据模型 / 接口 / 依赖 / 部署 / 风险"),
    "INTERACTIONS.md": head("交互流程与验收", "逐步交互 + 每步检查/验收标准"),
    "GAPS.md": `# 缺口台账 · Gaps\n\n> 客户：${clientName} ｜ 项目：${projectName}\n\n## 待客户回答\n\n_（暂无）_\n\n## 调研假设·待确认\n\n_（暂无）_\n\n## 已关闭\n\n_（暂无）_\n`,
    "INTAKE.md": `# 原始需求记录 · Intake\n\n> 客户：${clientName} ｜ 项目：${projectName}\n> 每轮原话/输入的累积摘要（只追加）。\n`,
  };
}

export async function listProjects(clientSlug: string): Promise<ProjectState[]> {
  const base = path.join(clientDir(clientSlug), "projects");
  if (!(await exists(base))) return [];
  const entries = await fs.readdir(base, { withFileTypes: true });
  const out: ProjectState[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const s = await readProjectState(clientSlug, e.name);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readProjectState(clientSlug: string, projectSlug: string): Promise<ProjectState | null> {
  let dir: string;
  try { dir = projectDir(clientSlug, projectSlug); } catch { return null; }
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")) as ProjectState;
  } catch {
    return null;
  }
}

export async function writeProjectState(s: ProjectState): Promise<void> {
  const dir = projectDir(s.clientSlug, s.slug);
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify(s, null, 2), "utf8");
}

export async function createProject(
  clientSlug: string,
  name: string,
  deliverable: Deliverable,
  model?: ModelSelection,
): Promise<ProjectState> {
  const client = await readClient(clientSlug);
  if (!client) throw new Error("客户不存在");
  const slug = slugify(name);
  const dir = projectDir(clientSlug, slug);
  if (await exists(dir)) throw new Error(`项目「${slug}」已存在`);
  await fs.mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const scaffold = docScaffold(client.name, name, deliverable, now.slice(0, 10));
  await Promise.all(Object.entries(scaffold).map(([f, c]) => fs.writeFile(path.join(dir, f), c, "utf8")));
  await fs.writeFile(path.join(dir, "conversation.jsonl"), "", "utf8");
  const state: ProjectState = {
    slug, clientSlug, name, deliverable,
    createdAt: now, updatedAt: now, rounds: 0, status: "intake", lastReadiness: null, model,
  };
  await writeProjectState(state);
  return state;
}

// —— 文档 / 会话（挂在项目下）——
export async function readDoc(clientSlug: string, projectSlug: string, file: string): Promise<string | null> {
  if (!SPEC_DOCS.includes(file as never)) return null;
  let dir: string;
  try { dir = projectDir(clientSlug, projectSlug); } catch { return null; }
  const p = path.join(dir, file);
  if (!(await exists(p))) return null;
  return fs.readFile(p, "utf8");
}

export async function readAllDocs(clientSlug: string, projectSlug: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of SPEC_DOCS) {
    const c = await readDoc(clientSlug, projectSlug, f);
    if (c != null) out[f] = c;
  }
  return out;
}

export async function appendConversation(clientSlug: string, projectSlug: string, entry: ConversationEntry): Promise<void> {
  const p = path.join(projectDir(clientSlug, projectSlug), "conversation.jsonl");
  await fs.appendFile(p, JSON.stringify(entry) + "\n", "utf8");
}

export async function readConversation(clientSlug: string, projectSlug: string): Promise<ConversationEntry[]> {
  const p = path.join(projectDir(clientSlug, projectSlug), "conversation.jsonl");
  if (!(await exists(p))) return [];
  const raw = await fs.readFile(p, "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ConversationEntry);
}
