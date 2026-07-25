// 验证 /deploy 的构建前处理:纯静态原样、无 build 脚本原样、产物目录探测优先级。
// (真实 install+build 走 e2e;这里只测不跑子进程的分支 + 目录探测。)
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildIfNeeded, findDeployableOutput } from "../src/deploy.js";
import { sandboxEnv } from "../src/providers.js";

async function mk(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deploybuild-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  return dir;
}

async function main() {
  // 1. 无 package.json → 纯静态,原目录、不 build
  const staticDir = await mk({ "index.html": "<h1>hi</h1>" });
  const r1 = await buildIfNeeded(staticDir);
  assert.equal(r1.built, false, "纯静态不该 build");
  assert.equal(r1.deployDir, staticDir, "纯静态应部署原目录");

  // 2. 有 package.json 但无 build 脚本 → 当作静态,不 build
  const noBuild = await mk({ "package.json": JSON.stringify({ name: "x", scripts: { start: "node ." } }), "index.html": "x" });
  const r2 = await buildIfNeeded(noBuild);
  assert.equal(r2.built, false, "无 build 脚本不该 build");
  assert.equal(r2.deployDir, noBuild);

  // 3. 产物目录探测优先级:out > dist > build > .vercel/output/static > public
  const noOut = await mk({ "README.md": "x" });
  assert.equal(await findDeployableOutput(noOut), null, "无产物目录应返回 null");

  const withDist = await mk({ "dist/index.html": "built" });
  assert.equal(await findDeployableOutput(withDist), path.join(withDist, "dist"), "应命中 dist");

  const withOutAndDist = await mk({ "out/index.html": "o", "dist/index.html": "d" });
  assert.equal(await findDeployableOutput(withOutAndDist), path.join(withOutAndDist, "out"), "out 优先于 dist");

  const withVercel = await mk({ ".vercel/output/static/index.html": "v" });
  assert.equal(
    await findDeployableOutput(withVercel),
    path.join(withVercel, ".vercel/output/static"),
    "应命中 next-on-pages 的 .vercel/output/static",
  );

  // 4. 安全(pr-daemon #68):build 用的 sandboxEnv 必须剥离 secret、保留构建变量。
  const buildEnv = sandboxEnv(
    { PATH: "/usr/bin", HOME: "/root", WORKBENCH_CALLBACK_SECRET: "s", CLOUDFLARE_API_TOKEN: "t", PAGES_CF_TOKEN_THAI_TEA: "p", DEEPSEEK_API_KEY: "k", GITHUB_BOT_TOKEN: "g", WORKBENCH_TOKEN: "w" },
    { CI: "1", NEXT_TELEMETRY_DISABLED: "1" },
  );
  for (const secret of ["WORKBENCH_CALLBACK_SECRET", "CLOUDFLARE_API_TOKEN", "PAGES_CF_TOKEN_THAI_TEA", "DEEPSEEK_API_KEY", "GITHUB_BOT_TOKEN", "WORKBENCH_TOKEN"]) {
    assert.ok(!(secret in buildEnv), `build env 绝不能含 secret ${secret}`);
  }
  assert.equal(buildEnv.PATH, "/usr/bin", "build env 应保留 PATH");
  assert.equal(buildEnv.CI, "1", "build env 应保留构建变量 CI");

  for (const d of [staticDir, noBuild, noOut, withDist, withOutAndDist, withVercel]) {
    await fs.rm(d, { recursive: true, force: true });
  }
  console.log("🎉 deploy 构建前处理 —— 全部断言通过(纯静态原样、产物目录探测、build env 剥离 secret)");
}

main().catch((e) => {
  console.error("✗ 测试失败:", e);
  process.exit(1);
});
