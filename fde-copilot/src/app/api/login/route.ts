import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { originError, signSession, sessionValid, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

/** 常量时间比较（防口令校验时序侧信道）。 */
function eq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// GET /api/login → 供前端启动时探测是否已登录（不泄漏任何凭据）。
// 也回报服务端是否启用了控制台登录（未配 WORKBENCH_UI_PASSWORD 时前端可提示走 token）。
export async function GET(req: Request) {
  const oe = originError(req);
  if (oe) return oe;
  return NextResponse.json({
    authed: sessionValid(req),
    loginEnabled: !!process.env.WORKBENCH_UI_PASSWORD?.trim(),
  });
}

// POST /api/login { password } → 校验 WORKBENCH_UI_PASSWORD，通过则下发签名 httpOnly cookie。
// 本端点是「授权入口」，不套 authError（否则无从登录）；但仍走 originError 挡跨站。
export async function POST(req: Request) {
  const oe = originError(req);
  if (oe) return oe;
  const pw = process.env.WORKBENCH_UI_PASSWORD?.trim();
  if (!pw) {
    return NextResponse.json(
      { error: "控制台登录未启用（服务端未配置 WORKBENCH_UI_PASSWORD）" },
      { status: 501 },
    );
  }
  let body: { password?: string };
  try {
    body = (await req.json()) as { password?: string };
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const got = typeof body.password === "string" ? body.password : "";
  if (!got || !eq(got, pw)) {
    return NextResponse.json({ error: "密码错误" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, signSession(), {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
  return res;
}

// DELETE /api/login → 登出（清 cookie）。
export async function DELETE(req: Request) {
  const oe = originError(req);
  if (oe) return oe;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return res;
}
