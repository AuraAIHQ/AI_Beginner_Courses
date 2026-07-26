// CC-69:验证 router 路径规范化(尾斜杠/双斜杠 → 归一),修 hack5 /plan 404。
import assert from "node:assert/strict";
import { normalizePath, routePath } from "../src/routing.js";

const cases: [string, string][] = [
  ["/plan", "/plan"],
  ["/plan/", "/plan"], // 尾斜杠(hack5 404 元凶之一)
  ["//plan", "/plan"], // 双斜杠(loopBase 尾部带 / → //plan)
  ["/plan//", "/plan"],
  ["///plan///", "/plan"],
  ["/estimate", "/estimate"],
  ["/status/abc", "/status/abc"],
  ["/status/abc/", "/status/abc"], // 带参路由去尾斜杠不影响 jobId 提取
  ["/", "/"],
  ["//", "/"],
  ["", "/"],
];

for (const [input, want] of cases) {
  assert.equal(normalizePath(input), want, `normalizePath(${JSON.stringify(input)}) 应为 ${want}`);
}

// routePath:从原始 req.url 提取(关键:双斜杠不能被 new URL 误解析成 host)。
const routeCases: [string, string][] = [
  ["/plan", "/plan"],
  ["//plan", "/plan"], // ★ 回归:new URL 会把它当协议相对 URL(host=plan),必须走 split 不走 new URL
  ["/plan/", "/plan"],
  ["/plan?x=1", "/plan"], // query 剥掉
  ["/plan#frag", "/plan"], // fragment 剥掉
  ["//plan/?a=1", "/plan"],
  ["/status/abc/", "/status/abc"],
  ["/", "/"],
];
for (const [input, want] of routeCases) {
  assert.equal(routePath(input), want, `routePath(${JSON.stringify(input)}) 应为 ${want}`);
}

console.log("🎉 normalizePath + routePath —— 全部断言通过(尾/双斜杠、query、协议相对误解析防护,CC-69)");
