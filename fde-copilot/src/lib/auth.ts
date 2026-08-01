import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

/** 常量时间比较，避免 token 校验的时序侧信道 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * 授权 origin 白名单（B3 补强）。默认放行本机 UI（workbench.aastar.io）+ 授权合作方
 * hack5.net(含子域) + 本地开发。可用 WORKBENCH_ALLOWED_ORIGINS（逗号分隔 host）覆盖。
 * 条目容忍写成完整 URL / 带端口，统一取 hostname 小写比对。
 */
function allowedOrigins(): string[] {
  const raw = process.env.WORKBENCH_ALLOWED_ORIGINS?.trim();
  const defaults = "workbench.aastar.io,hack5.net,localhost,127.0.0.1";
  return (raw || defaults)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => s.replace(/^https?:\/\//, "").replace(/[:/].*$/, "")); // 容忍 URL/端口
}

/** Origin header 的 host 是否在白名单（精确 host 或其子域）。 */
export function originAllowed(originHeader: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(originHeader).hostname.toLowerCase();
  } catch {
    return false; // Origin 存在但不可解析 → 拒
  }
  return allowedOrigins().some((a) => hostname === a || hostname.endsWith("." + a));
}

/**
 * 授权 origin 门禁（B3）。**只对带 Origin 的请求生效**——浏览器跨站请求会带 Origin，
 * 不在白名单的域（"不是我的应用"）一律 403；hack5 的 Worker 是服务端调用、**无 Origin**，
 * 放行去走 token 门禁（其真正的准入凭据是只有 hack5 持有的共享密钥）。
 * 由 authError / scopedAuthError 在最前面调用，覆盖所有 API route。
 */
export function originError(req: Request): NextResponse | null {
  const origin = req.headers.get("origin");
  if (!origin) return null; // 无 Origin = 服务端调用（hack5 Worker）→ 交给 token 门禁
  if (!originAllowed(origin)) {
    return NextResponse.json({ error: "forbidden：origin 未授权" }, { status: 403 });
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 第一方浏览器控制台登录 session（PR #85 正确修法：用**服务端签名的 httpOnly cookie**，
// 而非可被非浏览器客户端伪造的请求头）。cookie 由 /api/login 在校验 WORKBENCH_UI_PASSWORD
// 后签发；auth 门禁接受「有效 session cookie」或「x-workbench-token」二选一（hack5 走 header 不变）。
//   cookie 值 = base64url(payloadJson) + "." + base64url(HMAC_SHA256(payloadBytes, uiSecret()))
//   payload = { iat, exp }（仅证明「持 UI 密码者登录过」，不含身份）。签名密钥 curl 拿不到 → 无法伪造。
// ─────────────────────────────────────────────────────────────────────────────
export const SESSION_COOKIE = "wb_session";
const SESSION_TTL_SEC = 12 * 60 * 60;

/** 签名密钥：优先 WORKBENCH_UI_SECRET，回落 WORKBENCH_TOKEN（两者皆为服务端密钥，客户端拿不到）。 */
function uiSecret(): string {
  return process.env.WORKBENCH_UI_SECRET?.trim() || process.env.WORKBENCH_TOKEN?.trim() || "";
}

/** 签发一条 session cookie 值（供 /api/login 用 Set-Cookie 下发）。 */
export function signSession(ttlSec = SESSION_TTL_SEC): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + ttlSec }), "utf8");
  const sig = createHmac("sha256", uiSecret()).update(payload).digest();
  return `${payload.toString("base64url")}.${sig.toString("base64url")}`;
}

/** 校验请求携带的 session cookie：签名对且未过期 → true。无密钥/无 cookie/过期/伪造 → false。 */
export function sessionValid(req: Request): boolean {
  const secret = uiSecret();
  if (!secret) return false;
  const cookieHeader = req.headers.get("cookie") || "";
  const entry = cookieHeader
    .split(/;\s*/)
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!entry) return false;
  const value = entry.slice(SESSION_COOKIE.length + 1);
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return false;
  let payloadBuf: Buffer;
  let gotSig: Buffer;
  try {
    payloadBuf = Buffer.from(value.slice(0, dot), "base64url");
    gotSig = Buffer.from(value.slice(dot + 1), "base64url");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", secret).update(payloadBuf).digest();
  if (gotSig.length !== expected.length || !timingSafeEqual(gotSig, expected)) return false;
  try {
    const claims = JSON.parse(payloadBuf.toString("utf8")) as { exp?: number };
    if (typeof claims.exp === "number" && Date.now() / 1000 > claims.exp) return false;
  } catch {
    return false;
  }
  return true;
}

// ⚠️ 安全教训（PR #85 REQUEST_CHANGES / Codex PoC）：**不要**用 `Sec-Fetch-Site: same-origin`
// 之类的请求头做鉴权豁免。该头只有在**浏览器页面 JS**里才伪造不了（forbidden request header），
// 而 curl/脚本等非浏览器客户端可任意填写——中间没有浏览器把关。曾经的 firstPartyBrowser() 豁免
// 导致「无 Origin + 伪造 Sec-Fetch-Site」零认证绕过 WORKBENCH_TOKEN（建客户/项目、跑 chat 吃计费、
// 读 usage）。已移除。第一方浏览器控制台若要免密钥,必须用**客户端无法自填的凭据**：Cloudflare
// Access（边缘鉴权）或服务端签发的登录 session cookie（HMAC 签名 + httpOnly），不是请求头。

/**
 * 最小鉴权（admin / 编排层）：若设了 WORKBENCH_TOKEN，则所有 API 需带 `x-workbench-token`
 * 匹配头，否则 401。未设 token 时视为「仅本机使用」——配合默认 bind 127.0.0.1。
 * 面向公网/无人值守部署务必设置 WORKBENCH_TOKEN。
 *
 * 契约 v2 · B3：编排类调用（clients / projects / commit / usage）走此 admin 门禁；
 * 参赛者会话（chat / 读自己项目）走 scopedAuthError（作用域 token）。
 */
export function authError(req: Request): NextResponse | null {
  const oe = originError(req);
  if (oe) return oe;
  if (sessionValid(req)) return null; // 第一方浏览器控制台:签名 session cookie（非请求头）
  const token = process.env.WORKBENCH_TOKEN?.trim();
  if (!token) return null;
  const got = req.headers.get("x-workbench-token");
  if (!got || !safeEqual(got, token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

/**
 * 作用域 token 的 claim（W3 / B3）。由 hack5 用共享密钥 HMAC 签发，WorkBench 只验签 + 比对路径。
 * 令牌格式（双方共同合同）：
 *   token = base64url(payloadJson) + "." + base64url(HMAC_SHA256(payloadBytes, WORKBENCH_SCOPED_SECRET))
 *   payloadJson = { "client": "<clientSlug>", "project": "<projectSlug>", "exp"?: <unix 秒> }
 */
export interface ScopedClaims {
  client: string;
  project: string;
  exp?: number;
}

/** 验签作用域 token；失败/过期/格式错一律返回 null。签发方=hack5，此处只验。 */
export function verifyScopedToken(token: string, secret: string): ScopedClaims | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const p = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payloadBuf: Buffer;
  let gotSig: Buffer;
  try {
    payloadBuf = Buffer.from(p, "base64url");
    gotSig = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret).update(payloadBuf).digest();
  if (gotSig.length !== expected.length || !timingSafeEqual(gotSig, expected)) return null;
  let claims: ScopedClaims;
  try {
    claims = JSON.parse(payloadBuf.toString("utf8")) as ScopedClaims;
  } catch {
    return null;
  }
  if (!claims.client || !claims.project) return null;
  if (typeof claims.exp === "number" && Date.now() / 1000 > claims.exp) return null;
  return claims;
}

/**
 * 参赛者会话鉴权（W3 / B3）。放行两类之一，否则 401/403：
 *   1) admin token（= WORKBENCH_TOKEN）——hack5 server-to-server / 本地测试全通；
 *   2) 作用域 token（HMAC 签发，claim 含 client/project）且 claim 与请求项目**一致**。
 * 头统一用 `x-workbench-token`。都没配（无 admin & 无 secret）→ 视为仅本机使用，放行。
 * 越权（claim 与请求项目不符）→ 403，实现「每个参赛者只能访问自己的 project」。
 */
export function scopedAuthError(
  req: Request,
  clientSlug: string,
  projectSlug: string,
): NextResponse | null {
  const oe = originError(req);
  if (oe) return oe;
  // 第一方浏览器控制台:签名 session cookie 放行(非请求头 —— 请求头可被非浏览器客户端伪造,见上)。
  if (sessionValid(req)) return null;
  const admin = process.env.WORKBENCH_TOKEN?.trim();
  const secret = process.env.WORKBENCH_SCOPED_SECRET?.trim();
  // 都没配 → 仅本机使用，放行（与 authError 语义一致）
  if (!admin && !secret) return null;

  const got = req.headers.get("x-workbench-token");
  if (!got) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // admin 全通
  if (admin && safeEqual(got, admin)) return null;

  // 作用域 token：验签 + 比对路径子树
  if (secret) {
    const claims = verifyScopedToken(got, secret);
    if (claims) {
      if (claims.client === clientSlug && claims.project === projectSlug) return null;
      return NextResponse.json(
        { error: "forbidden：token 作用域与请求项目不符" },
        { status: 403 },
      );
    }
  }
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
