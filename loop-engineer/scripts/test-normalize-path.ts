// CC-69:验证 router 路径规范化(尾斜杠/双斜杠 → 归一),修 hack5 /plan 404。
import assert from "node:assert/strict";
import { normalizePath } from "../src/routing.js";

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

console.log("🎉 normalizePath —— 全部断言通过(尾斜杠/双斜杠/多斜杠归一,CC-69 /plan 404 修复)");
