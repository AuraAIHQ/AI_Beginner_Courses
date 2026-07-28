import { promises as fs } from "node:fs";
import path from "node:path";
import type { Client, ConversationEntry, Deliverable, ProjectState } from "./types";
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

// ─────────────────────────────────────────────────────────────────────────────
// CC-77 · 持久元数据存储（client.json / state.json / conversation.jsonl）
//
// 病根：fde-copilot 跑在单例 CF Container，clients/ 只写容器本地盘 + gitignored，
// 容器 sleepAfter:1h ephemeral → 冷启/重部署即丢盘 → client + usage 全没 →
// GET /api/usage?client= 返回 404「客户不存在」→ hack5 结算拉不到 → 预扣永久卡 reserved。
//
// 修法：把「持久数据模型」（客户 client.json / 项目状态 state.json[含 usage]）落到
// Worker 侧 D1（durable），容器经 HTTP shim（/_store/*，见 deploy/fde-copilot/src/index.ts）读写。
// 未配 WORKBENCH_STORE_URL 时回落本地文件（本地开发行为与旧版完全一致）。
//
// 注意边界：SPEC_DOCS（SPEC.md 等生成文档）+ conversation.jsonl（会话）**不**入库 ——
// 它们由 agent-sdk 直接写在 projectDir 工作目录、并由 git.ts push 交付，是「每会话工作集」，
// 非持久数据模型；且把无界增长的会话拼进 D1 单个 TEXT 值会撞上限。故二者仍走文件系统
// （readDoc/readAllDocs/appendConversation/readConversation + createProject 的 scaffold 写盘）。
// usage/结算所需的 state.json.usage 已落 D1 → 已足以根治 /api/usage 404 卡结算。
// ─────────────────────────────────────────────────────────────────────────────
interface MetaStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** prefix 下的直接子段名（模拟 readdir）。prefix="" → 客户 slug；"<c>/projects/" → 项目 slug。 */
  children(prefix: string): Promise<string[]>;
}

/** 本地开发回落：读写与旧版同一份 clients/ 磁盘布局，行为不变。 */
class FsMetaStore implements MetaStore {
  private full(key: string): string {
    const p = path.resolve(CLIENTS_DIR, key);
    if (p !== CLIENTS_DIR && !p.startsWith(CLIENTS_DIR + path.sep)) {
      throw new Error(`存储键越界：${key}`);
    }
    return p;
  }
  async read(key: string): Promise<string | null> {
    try { return await fs.readFile(this.full(key), "utf8"); } catch { return null; }
  }
  async write(key: string, value: string): Promise<void> {
    const p = this.full(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, value, "utf8");
  }
  async exists(key: string): Promise<boolean> {
    return exists(this.full(key));
  }
  async children(prefix: string): Promise<string[]> {
    const base = prefix ? this.full(prefix) : CLIENTS_DIR;
    try {
      const entries = await fs.readdir(base, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }
}

/** 生产：经 Worker /_store shim 落 D1（跨容器重启存活）。共享密钥 = WORKBENCH_TOKEN。 */
class HttpMetaStore implements MetaStore {
  constructor(private base: string, private secret: string) {}
  private async call(op: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base.replace(/\/+$/, "")}/_store/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-store-secret": this.secret },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`store ${op} → HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
  async read(key: string): Promise<string | null> {
    const r = await this.call("get", { k: key });
    return typeof r.v === "string" ? r.v : null;
  }
  async write(key: string, value: string): Promise<void> {
    await this.call("put", { k: key, v: value });
  }
  async exists(key: string): Promise<boolean> {
    const r = await this.call("exists", { k: key });
    return r.exists === true;
  }
  async children(prefix: string): Promise<string[]> {
    const r = await this.call("list", { prefix });
    return Array.isArray(r.children) ? (r.children as string[]) : [];
  }
}

// 存储密钥（两端必须一致）：优先 WORKBENCH_STORE_SECRET，回落 WORKBENCH_TOKEN。
// 不再回落 WORKBENCH_SCOPED_SECRET —— 那是 hack5 参赛者 token 的 HMAC 签名密钥，用途不同，
// 若两端来源不对称会导致「一端配了、Worker 侧没配 → 静默公开存储」。Worker handleStore 用同一条链。
function storeSecret(): string {
  return process.env.WORKBENCH_STORE_SECRET?.trim() || process.env.WORKBENCH_TOKEN?.trim() || "";
}

const meta: MetaStore = (() => {
  const url = process.env.WORKBENCH_STORE_URL?.trim();
  return url ? new HttpMetaStore(url, storeSecret()) : new FsMetaStore();
})();

const clientKey = (clientSlug: string) => `${clientSlug}/client.json`;
const stateKey = (clientSlug: string, projectSlug: string) => `${clientSlug}/projects/${projectSlug}/state.json`;

// —— 客户 ——
export async function listClients(): Promise<Client[]> {
  const out: Client[] = [];
  for (const slug of await meta.children("")) {
    const c = await readClient(slug);
    if (c) out.push(c);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readClient(clientSlug: string): Promise<Client | null> {
  try { assertSafe(clientSlug); } catch { return null; }
  const raw = await meta.read(clientKey(clientSlug));
  if (raw == null) return null;
  try { return JSON.parse(raw) as Client; } catch { return null; }
}

export async function writeClient(c: Client): Promise<void> {
  assertSafe(c.slug);
  await meta.write(clientKey(c.slug), JSON.stringify(c, null, 2));
}

export async function createClient(name: string, background: string): Promise<Client> {
  const slug = slugify(name);
  assertSafe(slug);
  if (await meta.exists(clientKey(slug))) {
    throw new Error(`客户「${slug}」已存在`);
  }
  const now = new Date().toISOString();
  const c: Client = { slug, name, background: background.trim(), createdAt: now, updatedAt: now };
  await writeClient(c);
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
  try { assertSafe(clientSlug); } catch { return []; }
  const out: ProjectState[] = [];
  for (const slug of await meta.children(`${clientSlug}/projects/`)) {
    const s = await readProjectState(clientSlug, slug);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readProjectState(clientSlug: string, projectSlug: string): Promise<ProjectState | null> {
  try { assertSafe(clientSlug); assertSafe(projectSlug); } catch { return null; }
  const raw = await meta.read(stateKey(clientSlug, projectSlug));
  if (raw == null) return null;
  try { return JSON.parse(raw) as ProjectState; } catch { return null; }
}

export async function writeProjectState(s: ProjectState): Promise<void> {
  assertSafe(s.clientSlug); assertSafe(s.slug);
  await meta.write(stateKey(s.clientSlug, s.slug), JSON.stringify(s, null, 2));
}

export async function createProject(clientSlug: string, name: string, deliverable: Deliverable): Promise<ProjectState> {
  const client = await readClient(clientSlug);
  if (!client) throw new Error("客户不存在");
  const slug = slugify(name);
  assertSafe(slug);
  if (await meta.exists(stateKey(clientSlug, slug))) throw new Error(`项目「${slug}」已存在`);
  const now = new Date().toISOString();
  // 文档是「每会话工作集」：由 agent-sdk 直接读写 projectDir、git push 交付 → 仍落文件系统。
  const dir = projectDir(clientSlug, slug);
  await fs.mkdir(dir, { recursive: true });
  const scaffold = docScaffold(client.name, name, deliverable, now.slice(0, 10));
  await Promise.all(Object.entries(scaffold).map(([f, c]) => fs.writeFile(path.join(dir, f), c, "utf8")));
  await fs.writeFile(path.join(dir, "conversation.jsonl"), "", "utf8");
  // 项目状态（含 usage）是持久数据模型 → 落 meta store（生产 = D1）。
  const state: ProjectState = {
    slug, clientSlug, name, deliverable,
    createdAt: now, updatedAt: now, rounds: 0, status: "intake", lastReadiness: null,
  };
  await writeProjectState(state);
  return state;
}

// —— 文档（挂在项目下，工作集，走文件系统）——
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

// —— 会话（每会话工作集，走文件系统）——
// 与 SPEC_DOCS 一致:conversation.jsonl 是「工作集」而非持久数据模型,故走 fs,不入 D1。
// 这也避免把无界增长的会话拼进 D1 单个 TEXT 值撞上限(会让后续 append 恒抛)。
// 持久数据模型 = client + project-state(含 usage),已落 meta store,足以修 /api/usage 404。
export async function appendConversation(clientSlug: string, projectSlug: string, entry: ConversationEntry): Promise<void> {
  const p = path.join(projectDir(clientSlug, projectSlug), "conversation.jsonl");
  await fs.appendFile(p, JSON.stringify(entry) + "\n", "utf8");
}

export async function readConversation(clientSlug: string, projectSlug: string): Promise<ConversationEntry[]> {
  let dir: string;
  try { dir = projectDir(clientSlug, projectSlug); } catch { return []; }
  const p = path.join(dir, "conversation.jsonl");
  if (!(await exists(p))) return [];
  const raw = await fs.readFile(p, "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ConversationEntry);
}
