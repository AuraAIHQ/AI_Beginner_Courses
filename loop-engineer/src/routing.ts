/**
 * 路由路径规范化(CC-69)。独立无副作用模块,便于单测(server.ts import 会自启动服务)。
 *
 * 折叠重复斜杠 + 去尾斜杠,空则回退 "/"。`//plan` / `/plan/` / `/plan` 都归一到 `/plan`;
 * `/status/abc/` → `/status/abc`。修 hack5 因 WORKBENCH_LOOP_URL 尾部带 `/` 发出 `//plan`
 * 导致带好 token 也 404 的回归(而同 host 的 /estimate 走另一条干净构造不受影响)。
 */
export function normalizePath(pathname: string): string {
  return "/" + pathname.split("/").filter(Boolean).join("/");
}

/**
 * 从原始 req.url 取规范化路由路径。**不经 `new URL`** —— `new URL("//plan","http://x")` 会把
 * `//plan` 当协议相对 URL(host="plan"、pathname="/"),双斜杠就漏了。直接剥掉 query(?)/fragment(#)
 * 再 normalizePath 才能正确处理 `//plan` / `/plan/` / `/plan?x=1`。
 */
export function routePath(rawUrl: string): string {
  return normalizePath(rawUrl.split(/[?#]/, 1)[0]);
}
