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
// 同项目串行锁（review #85：并发 /api/chat 丢轮次 + 丢计费）
//
// state 的更新是 read-modify-write（rounds+1、usage 累加），工作集备份也是「读全量文件 → 重算末块
// → 写回」。同一项目两个并发请求会互相覆盖：两轮都读到 rounds=N，都写 N+1 → 少记一轮，usage 也只
// 剩后写者那份 → 结算直接漏账；较早请求的 stale 末块还可能盖掉较晚请求刚写的备份。
//
// 语义上同一项目的对话本来就该串行，故直接把「读 state → 跑一轮 → 写 state」整段串行化。
// **限界**：进程内锁，只在当前部署形态（CF Container 单例）下成立。若将来横向扩容多实例，
// 必须换成 Durable Object 或 D1 上的 CAS/版本号 —— 别把这个锁当成分布式互斥。
// ─────────────────────────────────────────────────────────────────────────────
const projectLocks = new Map<string, Promise<void>>();

export function withProjectLock<T>(clientSlug: string, projectSlug: string, fn: () => Promise<T>): Promise<T> {
  const key = `${clientSlug}/${projectSlug}`;
  const prev = projectLocks.get(key) ?? Promise.resolve();
  // 前一个失败也必须放行下一个，否则一次异常会把这个项目永久锁死。
  const run = prev.then(fn, fn);
  const settled = run.then(
    () => {},
    () => {},
  );
  projectLocks.set(key, settled);
  // 自己是队尾时清理，避免 Map 随项目数无界增长。
  void settled.then(() => {
    if (projectLocks.get(key) === settled) projectLocks.delete(key);
  });
  return run;
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
// 工作集（SPEC_DOCS + conversation.jsonl）**读写仍走文件系统** —— agent-sdk 直接读写 projectDir、
// git.ts 从盘上取内容交付。但盘是 ephemeral，故另有一份**镜像备份**进同一 store（见下方
// 「工作集备份」段），冷启动时写回盘。会话按行切块存多个 key，不会把无界增长的文本塞进单个 TEXT 值。
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

// ─────────────────────────────────────────────────────────────────────────────
// CC-77 · 工作集备份（PR #85 二轮 review blocking）
//
// 上一版的「冷启动水合」用 docScaffold() 重铺 7 个空模板 —— 那不是恢复，是**伪造**：
// 冷启后 D1 里 rounds=N，盘上却是白板，agent 在零上文下继续跑、rounds 继续往上加，
// 用户收不到任何信号（先前那个 ENOENT 500 反而是唯一的探测器）。用一块看起来合理的白板
// 换掉一次响亮的失败，在失败场景下严格更差。
//
// 本段是真备份/真恢复：
//  · docs —— 每轮结束后整份镜像进 store（7 个 key，各自一份文档全文）
//  · conversation —— 按行切成 ≤CONV_CHUNK_BYTES 的块存多个 key。切块是确定性的追加：
//    满块此后不再变化，故每次追加只需重写最后一块（full=true 时才全量写）。
// 不走「从 git remote 恢复」：AUTO_PUSH 默认 false（.env.example:28），大量项目根本没推过，
// 那条路恢复不到东西；store 是唯一每轮都写得到的持久出口。
//
// 恢复不了的老项目（本次改动之前建的、store 里没有备份）→ 判 lost，**绝不铺模板**，
// 由路由响亮报错交给用户决策（见 ensureProjectWorkset / WorksetState）。
// ─────────────────────────────────────────────────────────────────────────────
const CONV_CHUNK_BYTES = 192 * 1024; // D1 单值上限 2MB，UTF-8 多字节 + JSON 转义留足余量
const worksetDocKey = (c: string, p: string, file: string) => `${c}/projects/${p}/workset/docs/${file}`;
const worksetConvKey = (c: string, p: string, i: number) =>
  `${c}/projects/${p}/workset/conv/${String(i).padStart(5, "0")}.jsonl`;
/**
 * 会话块数 = 恢复时的**提交点**。没有它就只能「读到第一个缺失的块为止」，而块数只增不减的假设会被
 * reset（从空白重建）打破：旧会话留下 5 块残留，新会话只写 1 块，恢复时会把旧历史拼到新会话后面。
 * MetaStore 没有 delete（Worker shim 只有 get/put/exists/list），故用块数覆盖旧残块而非删除。
 * 写序：**先写块、后写 count** —— 中途崩溃只会少恢复最后一块，绝不错序拼接。
 */
const worksetConvCountKey = (c: string, p: string) => `${c}/projects/${p}/workset/conv/count`;

/**
 * 只有远端 store（生产 D1）才需要镜像：本地 FsMetaStore 的盘本身就是持久的，
 * 镜像等于把同一份内容在 clients/ 里写两遍（还会被 commitProject 一起 add 进去）。
 */
const MIRROR_WORKSET = !!process.env.WORKBENCH_STORE_URL?.trim();

/**
 * 单条 entry 的备份上限。D1 单值上限 2MB —— 超过它 meta.write 会直接失败，把「某人贴了一篇超长文」
 * 变成「这个项目从此备份不上」。故超限行在**备份里**替换为占位（盘上仍是全量原文），并在占位文本里
 * 明说它不可恢复 —— 这是有意的信息损失，不是静默截断。
 */
const MAX_ENTRY_BYTES = 1024 * 1024;

/** 备份用的行整形：超限 entry 换成同结构的占位，保证仍是合法 JSONL。 */
function capEntryForBackup(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= MAX_ENTRY_BYTES) return line;
  const note = "…（本条超过 1MB，备份中已替换为占位；完整原文只在容器盘上，重启后不可恢复）";
  let base: Partial<ConversationEntry> = {};
  try {
    const e = JSON.parse(line) as ConversationEntry;
    base = { role: e.role, at: e.at, text: (e.text ?? "").slice(0, 2000) + note };
  } catch {
    base = { role: "customer", at: new Date().toISOString(), text: note };
  }
  return JSON.stringify(base);
}

/**
 * 按行切块，每块 ≤ CONV_CHUNK_BYTES。**例外**：单行本身超过 CONV_CHUNK_BYTES 时自成一块且超限
 * （不按字节硬切，那会切断多字节 UTF-8 字符、也会切出非法 JSONL）；capEntryForBackup 已把
 * 真正危险的（>1MB）挡在前面，故实际落到 store 的块最大约 1MB，仍在 D1 单值上限内。
 */
function chunkConversation(raw: string): string[] {
  const lines = raw.split("\n").filter(Boolean).map((l) => capEntryForBackup(l) + "\n");
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const line of lines) {
    const b = Buffer.byteLength(line, "utf8");
    if (cur && curBytes + b > CONV_CHUNK_BYTES) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += line;
    curBytes += b;
  }
  if (cur) out.push(cur);
  return out;
}

/** 会话镜像。full=false 时只重写最后一块（满块内容不再变化，见上方说明）。 */
async function backupConversation(clientSlug: string, projectSlug: string, full = false): Promise<void> {
  if (!MIRROR_WORKSET) return;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(projectDir(clientSlug, projectSlug), "conversation.jsonl"), "utf8");
  } catch {
    return;
  }
  const chunks = chunkConversation(raw);
  if (chunks.length === 0) return;
  const from = full ? 0 : chunks.length - 1;
  for (let i = from; i < chunks.length; i++) {
    await meta.write(worksetConvKey(clientSlug, projectSlug, i), chunks[i]);
  }
  await meta.write(worksetConvCountKey(clientSlug, projectSlug), String(chunks.length));
}

/**
 * 文档镜像：把盘上现存的 SPEC_DOCS 整份写进 store。每轮对话结束调一次（文档由 agent 直接写盘，
 * 拦不到单次写，故按轮快照）。盘上不存在的文档跳过 —— 不覆盖 store 里已有的备份。
 */
export async function snapshotWorkset(clientSlug: string, projectSlug: string): Promise<void> {
  if (!MIRROR_WORKSET) return;
  const dir = projectDir(clientSlug, projectSlug);
  await Promise.all(
    SPEC_DOCS.map(async (f) => {
      let content: string;
      try {
        content = await fs.readFile(path.join(dir, f), "utf8");
      } catch {
        return;
      }
      await meta.write(worksetDocKey(clientSlug, projectSlug, f), content);
    }),
  );
  await backupConversation(clientSlug, projectSlug, true);
}

/**
 * 从 store 读出备份 —— **只读进内存，不落盘**。
 *
 * 落盘必须等 ensureProjectWorkset 判定「这份备份够用」之后再做（见 commitRestore）：否则备份不完整
 * 时盘上会留下半成品 conversation.jsonl，而它正是 present 的判据 —— 下一次调用就会把 lost 误判成
 * present，409 退化回「静默在残缺工作集上继续」，等于绕开本次修复。docs/conv 分开计数：会话没恢复
 * 出来 = agent 仍在零上文下跑，与全丢同类。
 */
async function readWorksetBackup(
  clientSlug: string,
  projectSlug: string,
): Promise<{ docs: Record<string, string>; conv: string | null; convChunks: number }> {
  if (!MIRROR_WORKSET) return { docs: {}, conv: null, convChunks: 0 };
  const docs: Record<string, string> = {};
  for (const f of SPEC_DOCS) {
    const v = await meta.read(worksetDocKey(clientSlug, projectSlug, f));
    if (v != null) docs[f] = v;
  }
  // 按 count 读，而不是「读到第一个缺失为止」—— 后者会把 reset 前的残留旧块也拼进来（见 worksetConvCountKey）。
  const rawCount = await meta.read(worksetConvCountKey(clientSlug, projectSlug));
  const count = Number(rawCount);
  if (!rawCount || !Number.isInteger(count) || count <= 0) return { docs, conv: null, convChunks: 0 };
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const v = await meta.read(worksetConvKey(clientSlug, projectSlug, i));
    // 块缺失 = 备份不完整。**不截断**：把前缀当完整历史交出去，就是把「丢了一半会话」伪装成
    // 恢复成功，与本次修复要根治的静默失忆同类。整份判为不可用，交由 lost 分支响亮报错。
    if (v == null) {
      console.error(`[workset] ${clientSlug}/${projectSlug} 会话备份缺第 ${i}/${count} 块，判为不可恢复`);
      return { docs, conv: null, convChunks: 0 };
    }
    parts.push(v);
  }
  const conv = parts.join("");
  // 完整性校验：拼出来的每行都必须是可解析的 JSONL，否则 readConversation() 会在后续任意一次
  // 项目详情请求里抛出、变成随机 500。宁可判不可恢复。
  for (const line of conv.split("\n")) {
    if (!line) continue;
    try {
      JSON.parse(line);
    } catch {
      console.error(`[workset] ${clientSlug}/${projectSlug} 会话备份含损坏行，判为不可恢复`);
      return { docs, conv: null, convChunks: 0 };
    }
  }
  return { docs, conv, convChunks: parts.length };
}

/** 把已判定可用的备份落盘。只在 ensureProjectWorkset 判 restored 后调用。 */
async function commitRestore(
  dir: string,
  backup: { docs: Record<string, string>; conv: string | null },
): Promise<void> {
  await Promise.all(
    Object.entries(backup.docs).map(([f, c]) => fs.writeFile(path.join(dir, f), c, "utf8")),
  );
  if (backup.conv != null) await fs.writeFile(path.join(dir, "conversation.jsonl"), backup.conv, "utf8");
}

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
function docScaffold(
  clientName: string,
  projectName: string,
  deliverable: Deliverable,
  now: string,
  banner = "",
): Record<string, string> {
  const head = (title: string, hint: string) =>
    `# ${title}\n${banner}\n> 客户：${clientName} ｜ 项目：${projectName} ｜ 交付物：${deliverable.name}（${deliverable.type}）\n> ${hint}\n> 本文件由 FDE Copilot 随每轮对话自动维护。\n\n_（尚未开始，等待输入）_\n`;
  return {
    "SPEC.md": head("需求规格 · Spec", "问题定义 / 目标 / 范围 / 成功指标 / 非目标"),
    "PRODUCT.md": head("产品描述 · Product", "一句话定位 / 目标用户 / 核心价值 / 关键场景"),
    "FEATURES.md": head("Feature 细节", "用户故事 + 验收标准 + 边界/异常 + 优先级"),
    "TECH_SPEC.md": head("技术方案 · Tech Spec", "架构 / 数据模型 / 接口 / 依赖 / 部署 / 风险"),
    "INTERACTIONS.md": head("交互流程与验收", "逐步交互 + 每步检查/验收标准"),
    "GAPS.md": `# 缺口台账 · Gaps\n${banner}\n> 客户：${clientName} ｜ 项目：${projectName}\n\n## 待客户回答\n\n_（暂无）_\n\n## 调研假设·待确认\n\n_（暂无）_\n\n## 已关闭\n\n_（暂无）_\n`,
    "INTAKE.md": `# 原始需求记录 · Intake\n${banner}\n> 客户：${clientName} ｜ 项目：${projectName}\n> 每轮原话/输入的累积摘要（只追加）。\n`,
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
  await scaffoldWorkset(clientSlug, slug, client.name, name, deliverable, now);
  // 项目状态（含 usage）是持久数据模型 → 落 meta store（生产 = D1）。
  const state: ProjectState = {
    slug, clientSlug, name, deliverable,
    createdAt: now, updatedAt: now, rounds: 0, status: "intake", lastReadiness: null,
  };
  await writeProjectState(state);
  await snapshotWorkset(clientSlug, slug); // 初始模板也进备份，冷启后能原样恢复
  return state;
}

/**
 * **铺空模板** —— 只在「确知这个项目没有历史」时调用（新建项目，或用户显式确认从空白重建）。
 * 与 ensureProjectWorkset 严格分开：这个函数有能力凭空造内容，所以调用点必须自己举证没有东西可丢。
 * `{ flag: "wx" }` 保证只补缺失文件、绝不覆盖已存在内容（同时关掉 exists→writeFile 的 TOCTOU 窗口）。
 */
async function scaffoldWorkset(
  clientSlug: string,
  projectSlug: string,
  clientName: string,
  projectName: string,
  deliverable: Deliverable,
  createdAt: string,
  banner = "",
): Promise<void> {
  const dir = projectDir(clientSlug, projectSlug);
  await fs.mkdir(dir, { recursive: true });
  const scaffold = docScaffold(clientName, projectName, deliverable, createdAt.slice(0, 10), banner);
  const writeIfAbsent = async (p: string, c: string) => {
    try {
      await fs.writeFile(p, c, { encoding: "utf8", flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  };
  await Promise.all(Object.entries(scaffold).map(([f, c]) => writeIfAbsent(path.join(dir, f), c)));
  await writeIfAbsent(path.join(dir, "conversation.jsonl"), "");
}

/**
 * 工作集当前状态。`lost` 是唯一需要路由拦下来的分支：D1 说这个项目有历史，盘上没了，
 * 备份里也没有 —— 此时任何「继续」都是在被抹掉的历史上继续，必须让用户知道。
 */
export type WorksetState =
  | { kind: "present" }                       // 盘上完好
  | { kind: "restored"; files: number }       // 冷启后从备份写回，内容真恢复了
  | { kind: "fresh" }                         // 确无历史（rounds=0）→ 铺模板安全
  // 有历史且会话无法恢复，用户显式确认后重建。restoredDocs>0 = 文档备份还在、已恢复真内容，
  // 丢的只是会话历史 —— 别把这种情况说成「从空白重建」，也别把能救的文档扔掉。
  | { kind: "reset"; rounds: number; restoredDocs: number }
  | { kind: "lost"; rounds: number };         // 有历史且无法恢复，未获确认 → 调用方必须拒绝本次操作

/**
 * 冷启动水合（PR #85 review）：CF 容器盘 ephemeral，重启后 D1 里仍有 client/state，
 * 但 projectDir 工作集（docs + conversation.jsonl）已随盘丢失 —— 任何 fs 写落在缺失父目录上会
 * ENOENT 500，任何 fs 读会静默读到空。本函数是所有「从 D1 state 走到磁盘」的路由的共享入口。
 *
 * 顺序：盘上完好 → present；否则先从 store 备份恢复真内容 → restored；备份也没有时按有无历史分叉：
 * rounds=0 → 铺模板（fresh，没有东西可丢）；rounds>0 → **不铺**，返回 lost 让路由响亮报错。
 * 只有调用方带 acceptLoss（用户已明确知情）才铺带丢失横幅的空模板 → reset。
 */
export async function ensureProjectWorkset(
  clientSlug: string,
  projectSlug: string,
  opts: { acceptLoss?: boolean } = {},
): Promise<WorksetState> {
  const state = await readProjectState(clientSlug, projectSlug);
  if (!state) throw new Error("项目不存在"); // 调用方应先 readProjectState 走 404
  const dir = projectDir(clientSlug, projectSlug); // slug 已由 readProjectState 的 assertSafe 把关

  // conversation.jsonl 是工作集是否在盘上的判据：createProject / scaffoldWorkset / restoreWorkset
  // 三条路径都会建它，且 agent 不会删它。
  if (await exists(path.join(dir, "conversation.jsonl"))) return { kind: "present" };

  const backup = await readWorksetBackup(clientSlug, projectSlug);
  const docCount = Object.keys(backup.docs).length;
  // 会话必须一并恢复：rounds>0 却没恢复出会话，等于 agent 照样在零上文下继续跑（文档恢复了也一样），
  // 与「全丢」同类，按 lost 处理，不做「恢复了一半」的乐观判定。
  const convOk = state.rounds === 0 || backup.convChunks > 0;
  if (docCount > 0 && convOk) {
    await fs.mkdir(dir, { recursive: true });
    await commitRestore(dir, backup);
    // 备份恢复出的文档可能少于 7 个（某轮镜像失败）：补齐缺的空模板，不动恢复到的。
    const client = await readClient(clientSlug);
    await scaffoldWorkset(
      clientSlug, projectSlug, client?.name ?? clientSlug, state.name, state.deliverable, state.createdAt,
    );
    return { kind: "restored", files: docCount + backup.convChunks };
  }

  // 判定不通过 → 盘上保持原样（一个字节都不落），确保下次调用仍走同一条 lost 分支而非误判 present。
  if (state.rounds > 0 && !opts.acceptLoss) return { kind: "lost", rounds: state.rounds };
  await fs.mkdir(dir, { recursive: true });

  // 用户已确认接受丢失。但「接受丢失」不等于「把还救得回来的也扔掉」：文档备份若在，照样恢复真内容，
  // 丢的仅是会话历史。恢复到的文档不加横幅（它们是真内容），横幅只落在确实凭空重建的空模板上。
  if (docCount > 0) await commitRestore(dir, { docs: backup.docs, conv: null });

  const client = await readClient(clientSlug);
  const banner =
    state.rounds > 0
      ? docCount > 0
        ? `\n> ⚠️ 会话历史已随容器重启丢失（丢失时第 ${state.rounds} 轮），文档已从备份恢复，但本文件当时没有备份，为空模板重建。\n`
        : `\n> ⚠️ 工作集已随容器重启丢失（丢失时第 ${state.rounds} 轮），内容**未恢复**；以下为空模板重建。\n> 此前生成的文档请到 git 交付仓库找回。\n`
      : "";
  await scaffoldWorkset(
    clientSlug, projectSlug, client?.name ?? clientSlug, state.name, state.deliverable, state.createdAt, banner,
  );
  return state.rounds > 0
    ? { kind: "reset", rounds: state.rounds, restoredDocs: docCount }
    : { kind: "fresh" };
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

// —— 会话（工作集：读写走文件系统，另有分块镜像备份进 store）——
export async function appendConversation(clientSlug: string, projectSlug: string, entry: ConversationEntry): Promise<void> {
  const dir = projectDir(clientSlug, projectSlug);
  // 防御性:冷启后目录可能随 ephemeral 盘丢失,fs.appendFile 不建父目录 → 否则 ENOENT 500(见 ensureProjectWorkset)。
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, "conversation.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  // 备份失败不阻断本轮：盘上已经写成功了，这里再抛就把「store 抖一下」升级成「聊天不可用」，
  // 而且抛在 runTurn 之前/之后都会让整轮白跑、state.usage 写不进去（正是本 PR 要修的那类问题）。
  // 轮末 snapshotWorkset(full=true) 会全量补写自愈；那一次仍然失败才是真警报，由路由暴露给用户。
  try {
    await backupConversation(clientSlug, projectSlug);
  } catch (e) {
    console.error(`[workset] 会话增量备份失败（轮末会全量重试）：${(e as Error).message}`);
  }
}

export async function readConversation(clientSlug: string, projectSlug: string): Promise<ConversationEntry[]> {
  let dir: string;
  try { dir = projectDir(clientSlug, projectSlug); } catch { return []; }
  const p = path.join(dir, "conversation.jsonl");
  if (!(await exists(p))) return [];
  const raw = await fs.readFile(p, "utf8");
  // 坏行跳过而不是抛：一条半截行（写盘中途断电/进程被杀）不该让项目详情整个 500 打不开。
  const out: ConversationEntry[] = [];
  for (const l of raw.split("\n")) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l) as ConversationEntry);
    } catch {
      console.error(`[workset] ${clientSlug}/${projectSlug} conversation.jsonl 含损坏行，已跳过`);
    }
  }
  return out;
}
