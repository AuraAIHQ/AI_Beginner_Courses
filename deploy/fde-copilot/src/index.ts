// CC-58 · fde-copilot 的 Cloudflare Worker + Container 前置代理
//
// 形态：单例容器（客户会话/spec 文件写在本地磁盘 + git push 交付；同会话须命中同一实例）。
// Worker 透传请求；fde-copilot 自身用 x-workbench-token / scoped token 鉴权（fail-closed）。
// 默认云模式 EXECUTION_MODE=api：full agent-sdk 路径走 DeepSeek 云端点，零本机订阅。
import { Container, getContainer } from "@cloudflare/containers";

const PASSTHROUGH_KEYS = [
  // 鉴权
  "WORKBENCH_TOKEN",
  "WORKBENCH_SCOPED_SECRET",
  "WORKBENCH_STORE_SECRET", // CC-77：/_store 专用密钥（可选，未配则回落 WORKBENCH_TOKEN，两端一致）
  // 模型云 key（快 chat 直连 HiLinkup；full 路径回落 DeepSeek 云端点；均非 Anthropic 官方）
  "HILINKUP_API_KEY",
  "HILINKUP_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_MODEL",
  "ANTHROPIC_API_KEY", // 可选兜底，非默认
  "CLAUDE_MODEL",
  // git push（把 spec 推到参赛者公有仓库）
  "WORKBENCH_PUSH_TOKEN",
  "WORKBENCH_PUSH_BRANCH",
  "WORKBENCH_ALLOWED_PUSH_HOSTS",
  // 行为可调
  "AGENT_MAX_TURNS",
  "CHAT_FULL_SPEC",
  "CHAT_WEBSEARCH",
] as const;

export interface Env {
  FDE_COPILOT: DurableObjectNamespace<FdeCopilotContainer>;
  // CC-77 · 持久元数据存储（client/project-state/conversation）。容器盘 ephemeral，
  // 数据模型落 D1；容器经 /_store/* HTTP shim 读写（见下方 handleStore）。
  FDE_STORE: D1Database;
  [key: string]: unknown;
}

function buildEnvVars(env: Env): Record<string, string> {
  const vars: Record<string, string> = {
    EXECUTION_MODE: "api",
    NODE_ENV: "production",
    // CC-61：/api/plan 代理转发目标（「上传现成 spec 一键构建」）。默认指向常驻 loop-engineer。
    LOOP_ENGINEER_URL:
      (typeof env.LOOP_ENGINEER_URL === "string" && env.LOOP_ENGINEER_URL) ||
      "https://loop.aastar.io",
    // CC-77：容器侧 clients.ts 用此 URL 走 /_store shim 落 D1（跨重启存活）。
    // 默认指向本 Worker 的自定义域；共享密钥复用 WORKBENCH_TOKEN。
    WORKBENCH_STORE_URL:
      (typeof env.WORKBENCH_STORE_URL === "string" && env.WORKBENCH_STORE_URL) ||
      "https://workbench.aastar.io",
  };
  for (const k of PASSTHROUGH_KEYS) {
    const v = env[k];
    if (typeof v === "string" && v.length > 0) vars[k] = v;
  }
  return vars;
}

export class FdeCopilotContainer extends Container<Env> {
  defaultPort = 3939;
  requiredPorts = [3939];
  sleepAfter = "1h";
  enableInternet = true; // 模型 API、git push、（可选）联网调研

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env);
    this.envVars = buildEnvVars(env);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CC-77 · 持久元数据 KV shim（D1 后端）
//
// 容器盘 ephemeral，client/usage 数据模型落 Worker 侧 D1；容器（clients.ts 的
// HttpMetaStore）POST 到 /_store/*，带 x-store-secret = WORKBENCH_TOKEN。
// 必须在 getContainer 代理之前拦截，否则会被转发进容器造成回环。
// ─────────────────────────────────────────────────────────────────────────────
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let tableReady = false;
async function ensureTable(db: D1Database): Promise<void> {
  if (tableReady) return; // 每 isolate 一次；CREATE IF NOT EXISTS 本身幂等，此 guard 省掉每请求一次往返。
  await db
    .prepare("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT NOT NULL)")
    .run();
  tableReady = true;
}

/** /_store 存储密钥（与容器侧 clients.ts storeSecret() 同一条链）。 */
function storeSecret(env: Env): string {
  const s = (env.WORKBENCH_STORE_SECRET as string | undefined)?.trim();
  const t = (env.WORKBENCH_TOKEN as string | undefined)?.trim();
  return s || t || "";
}

/** 转义 LIKE 的通配符，使 prefix 仅做字面前缀匹配。 */
function likePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`) + "%";
}

async function handleStore(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Fail-closed:本路由绑在公网 custom domain，任何时候都可达。若未配存储密钥，一律 503，
  // 绝不「未配=公开」——否则可被匿名读写计费 KV（读 PII / 篡改 usage / list 枚举全部 client）。
  const secret = storeSecret(env);
  if (!secret) return json({ error: "store 未配置密钥（WORKBENCH_STORE_SECRET / WORKBENCH_TOKEN）" }, 503);
  const got = request.headers.get("x-store-secret") || "";
  if (!safeEqual(got, secret)) return json({ error: "unauthorized" }, 401);

  const db = env.FDE_STORE;
  if (!db) return json({ error: "FDE_STORE 未绑定" }, 500);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const op = url.pathname.slice("/_store/".length);
  const key = typeof body.k === "string" ? body.k : "";
  await ensureTable(db);

  switch (op) {
    case "get": {
      const row = await db.prepare("SELECT v FROM kv WHERE k = ?1").bind(key).first<{ v: string }>();
      return json({ v: row?.v ?? null });
    }
    case "put": {
      const v = typeof body.v === "string" ? body.v : "";
      await db
        .prepare(
          "INSERT INTO kv (k,v,updated_at) VALUES (?1,?2,?3) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at",
        )
        .bind(key, v, new Date().toISOString())
        .run();
      return json({ ok: true });
    }
    case "exists": {
      const row = await db.prepare("SELECT 1 AS x FROM kv WHERE k = ?1 LIMIT 1").bind(key).first();
      return json({ exists: !!row });
    }
    case "list": {
      const prefix = typeof body.prefix === "string" ? body.prefix : "";
      const res = await db
        .prepare("SELECT k FROM kv WHERE k LIKE ?1 ESCAPE '\\'")
        .bind(likePrefix(prefix))
        .all<{ k: string }>();
      const seen = new Set<string>();
      for (const r of res.results ?? []) {
        const rest = r.k.slice(prefix.length);
        const seg = rest.split("/")[0];
        if (seg) seen.add(seg);
      }
      return json({ children: [...seen] });
    }
    default:
      return json({ error: `unknown op: ${op}` }, 404);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // CC-77：持久存储 shim 必须先于容器代理拦截。
    if (url.pathname.startsWith("/_store/")) return handleStore(request, env, url);
    // 单例：同会话命中同一容器（spec 文件 + git push 交付）。Container.fetch 自动冷启并代理。
    return getContainer(env.FDE_COPILOT, "singleton").fetch(request);
  },
};
