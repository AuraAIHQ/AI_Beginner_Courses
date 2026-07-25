// CC-63 P1:验证 runWithTimeout 是 race+grace —— 挂死、不响应 abort 的 fn 也会在 ms+grace 内
// 强制返回 timedOut(不再干等),这是「job 悬空、W5 终态回调永不发」僵尸单的根因修复。
import assert from "node:assert/strict";
import { runWithTimeout } from "../src/timeout.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. 挂死 fn(永不 resolve、无视 abort)→ 必须在 ms+grace 内强制返回 timedOut,不能干等
  const t0 = Date.now();
  const hung = await runWithTimeout<never>(() => new Promise<never>(() => {}), 50, 50);
  const elapsed = Date.now() - t0;
  assert.equal(hung.timedOut, true, "挂死 fn 应判 timedOut");
  assert.ok(elapsed < 1000, `不该干等挂死 fn(实际 ${elapsed}ms)`);

  // 2. 正常完成(先于超时)→ timedOut:false + value
  const ok = await runWithTimeout(async () => 42, 5000, 50);
  assert.equal(ok.timedOut, false);
  assert.equal(ok.value, 42);

  // 3. fn 响应 abort、在 grace 内收手 → timedOut:true(经 aborted)
  const polite = await runWithTimeout<string>(
    (signal) =>
      new Promise<string>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted by signal")));
      }),
    50,
    500,
  );
  assert.equal(polite.timedOut, true, "响应 abort 收手的 fn 也应 timedOut");

  // 4. ms<=0 → 不设超时,正常等 fn
  const noTimeout = await runWithTimeout(async () => {
    await sleep(20);
    return "done";
  }, 0);
  assert.equal(noTimeout.timedOut, false);
  assert.equal(noTimeout.value, "done");

  // 5. 抛普通错(非超时)→ timedOut:false + error
  const errored = await runWithTimeout(async () => {
    throw new Error("boom");
  }, 5000);
  assert.equal(errored.timedOut, false);
  assert.equal((errored.error as Error).message, "boom");

  console.log("🎉 runWithTimeout race+grace —— 全部断言通过(挂死 fn 不干等、强制 timedOut)");
}

main().catch((e) => {
  console.error("✗ 测试失败:", e);
  process.exit(1);
});
