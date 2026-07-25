// 验证 node_modules 根因修复(CC-60 stockalert):coder 没写 .gitignore 时,
// commitAll 不该把 node_modules 提交进去,diffAgainst 也不该让它污染评审 diff。
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commitAll, diffAgainst } from "../src/git.js";

const pexec = promisify(execFile);
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const g = (cwd: string, ...args: string[]) => pexec("git", ["-C", cwd, ...args], { env: ENV });

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gi-vendored-"));
  await g(dir, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(dir, "README.md"), "# base\n");
  await g(dir, "add", "-A");
  await g(dir, "commit", "-q", "-m", "base");
  await g(dir, "branch", "loop/integration");
  await g(dir, "checkout", "-q", "loop/integration");

  // 模拟 coder:写了真实源码,但也 npm install 出一堆 node_modules,且【没写 .gitignore】
  await fs.writeFile(path.join(dir, "app.js"), "export const real = () => 42;\n");
  await fs.mkdir(path.join(dir, "node_modules", "lodash"), { recursive: true });
  for (let i = 0; i < 50; i++) {
    await fs.writeFile(path.join(dir, "node_modules", "lodash", `f${i}.js`), "x".repeat(2000));
  }
  await fs.mkdir(path.join(dir, ".next"), { recursive: true });
  await fs.writeFile(path.join(dir, ".next", "build.js"), "y".repeat(2000));

  const committed = await commitAll(dir, "feat: real work");
  assert.equal(committed, true, "应有真实改动提交");

  // 1. 提交里不该有 node_modules / .next
  const { stdout: tracked } = await g(dir, "ls-files");
  assert.ok(!tracked.includes("node_modules/"), "node_modules 不该被提交");
  assert.ok(!tracked.includes(".next/"), ".next 不该被提交");
  assert.ok(tracked.includes("app.js"), "真实源码 app.js 应被提交");
  assert.ok(tracked.includes(".gitignore"), "应自动补出 .gitignore");

  // 2. 评审 diff 应含真实源码、不含 vendored
  const review = await diffAgainst(dir, "loop/integration~1");
  assert.ok(review.includes("app.js"), "评审 diff 应含真实源码");
  assert.ok(review.includes("real = () => 42"), "评审 diff 应含真实实现内容");
  assert.ok(!review.includes("node_modules/lodash"), "评审 diff 不该含 node_modules");
  assert.ok(review.length < 20000, `评审 diff 不该被 node_modules 撑爆(实际 ${review.length})`);

  // 3. 幂等:即便上一 attempt 误 tracked 了 node_modules,也能被剔除
  await fs.writeFile(path.join(dir, ".gitignore"), ""); // 清空 gitignore 模拟历史遗留
  await g(dir, "add", "-f", "node_modules/lodash/f0.js"); // 强行 track 一个
  await g(dir, "commit", "-q", "-m", "oops tracked");
  await fs.writeFile(path.join(dir, "app2.js"), "export const more = 1;\n");
  await commitAll(dir, "feat: more");
  const { stdout: tracked2 } = await g(dir, "ls-files");
  assert.ok(!tracked2.includes("node_modules/lodash/f0.js"), "已 tracked 的 node_modules 应被 rm --cached 剔除");

  await fs.rm(dir, { recursive: true, force: true });
  console.log("🎉 node_modules 根因修复 —— 全部断言通过(commit 不含 vendored、评审 diff 干净、幂等剔除)");
}

main().catch((e) => {
  console.error("✗ 测试失败:", e);
  process.exit(1);
});
