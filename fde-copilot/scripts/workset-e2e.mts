// 冷启动水合 E2E（CC-77 / PR #85）：内存版 /_store（模拟 D1）+ 真实 fs + 临时 cwd，
// 验证「丢盘 → 恢复真内容」「无备份 → lost 且绝不铺白板」「acceptLoss → 带横幅重建」「会话分块跨块恢复」。
//
//   跑法：pnpm --dir fde-copilot dlx tsx scripts/workset-e2e.mts
//   （必须 .mts —— 顶层 await；不碰用户数据，全在 os.tmpdir() 里）
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const kv = new Map<string, string>();
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const op = (req.url || "").slice("/_store/".length);
    const b = JSON.parse(body || "{}");
    const send = (o: unknown) => res.end(JSON.stringify(o));
    res.setHeader("content-type", "application/json");
    if (op === "get") return send({ v: kv.get(b.k) ?? null });
    if (op === "put") { kv.set(b.k, b.v); return send({ ok: true }); }
    if (op === "exists") return send({ exists: kv.has(b.k) });
    if (op === "list") {
      const seen = new Set<string>();
      for (const k of kv.keys()) if (k.startsWith(b.prefix)) { const s = k.slice(b.prefix.length).split("/")[0]; if (s) seen.add(s); }
      return send({ children: [...seen] });
    }
    res.statusCode = 404; send({ error: "unknown op" });
  });
});
await new Promise<void>((r) => server.listen(45711, "127.0.0.1", r));

const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wb-ws-e2e-"));
process.chdir(cwd);
process.env.WORKBENCH_STORE_URL = "http://127.0.0.1:45711";
process.env.WORKBENCH_STORE_SECRET = "test-secret";

const C = await import("../src/lib/clients.ts");

const ok = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? " — " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

// —— 场景 1：正常写内容 → 丢盘 → 恢复 ——
await C.createClient("ACME 客户", "背景");
const st = await C.createProject("acme-客户", "视频简历", { name: "我的视频简历", type: "video-resume" });
const dir = C.projectDir("acme-客户", "视频简历");

// 模拟 agent 写文档 + 两轮会话
await fs.writeFile(path.join(dir, "SPEC.md"), "# 真实 SPEC\n\n这是第 3 轮攒出来的内容。\n", "utf8");
await fs.writeFile(path.join(dir, "TECH_SPEC.md"), "# 技术方案\n\nD1 + 容器。\n", "utf8");
await C.appendConversation("acme-客户", "视频简历", { role: "customer", at: "t1", text: "我要做视频简历" });
await C.appendConversation("acme-客户", "视频简历", { role: "copilot", at: "t2", text: "好的，几个问题…" });
await C.snapshotWorkset("acme-客户", "视频简历");
await C.writeProjectState({ ...st, rounds: 3 });

// 冷启动：容器盘没了
await fs.rm(path.join(cwd, "clients", "acme-客户", "projects"), { recursive: true, force: true });
ok("丢盘后 projectDir 确实不在", !(await fs.access(dir).then(() => true).catch(() => false)));

const ws = await C.ensureProjectWorkset("acme-客户", "视频简历");
ok("水合判定 = restored", ws.kind === "restored", JSON.stringify(ws));
const spec = await C.readDoc("acme-客户", "视频简历", "SPEC.md");
ok("SPEC.md 恢复的是真内容而非空模板", spec?.includes("第 3 轮攒出来的内容") === true, spec?.slice(0, 40));
ok("TECH_SPEC.md 也恢复", (await C.readDoc("acme-客户", "视频简历", "TECH_SPEC.md"))?.includes("D1 + 容器") === true);
const conv = await C.readConversation("acme-客户", "视频简历");
ok("会话 2 条全恢复", conv.length === 2 && conv[0].text === "我要做视频简历", `len=${conv.length}`);
ok("从没写过的文档补空模板", (await C.readDoc("acme-客户", "视频简历", "GAPS.md"))?.includes("缺口台账") === true);

// 幂等：再调一次应为 present，且不覆盖内容
const ws2 = await C.ensureProjectWorkset("acme-客户", "视频简历");
ok("再次调用 = present", ws2.kind === "present", JSON.stringify(ws2));
ok("内容未被覆盖", (await C.readDoc("acme-客户", "视频简历", "SPEC.md"))?.includes("第 3 轮") === true);

// —— 场景 2：老项目（store 里有 state 无工作集备份）→ lost，且绝不铺模板 ——
const old = await C.createProject("acme-客户", "老项目", { name: "老交付物", type: "doc" });
await C.writeProjectState({ ...old, rounds: 7 });
const oldDir = C.projectDir("acme-客户", "老项目");
await fs.rm(oldDir, { recursive: true, force: true });
for (const k of [...kv.keys()]) if (k.includes("老项目/workset/")) kv.delete(k); // 模拟备份机制上线前

const ws3 = await C.ensureProjectWorkset("acme-客户", "老项目");
ok("无备份 + rounds>0 → lost", ws3.kind === "lost" && ws3.rounds === 7, JSON.stringify(ws3));
ok("lost 时不铺任何模板（盘上仍是空的）", (await fs.readdir(oldDir).catch(() => []) as string[]).length === 0);

// 用户显式确认 → reset，铺带横幅的模板
const ws4 = await C.ensureProjectWorkset("acme-客户", "老项目", { acceptLoss: true });
ok("acceptLoss → reset", ws4.kind === "reset" && ws4.rounds === 7, JSON.stringify(ws4));
const banner = await C.readDoc("acme-客户", "老项目", "SPEC.md");
ok("重建的模板带丢失横幅", banner?.includes("工作集已随容器重启丢失") === true, banner?.split("\n")[1]);

// —— 场景 3：rounds=0 的新项目丢盘 → fresh（没有东西可丢，铺模板安全）——
const brand = await C.createProject("acme-客户", "全新项目", { name: "新交付物", type: "web" });
await fs.rm(C.projectDir("acme-客户", "全新项目"), { recursive: true, force: true });
for (const k of [...kv.keys()]) if (k.includes("全新项目/workset/")) kv.delete(k);
const ws5 = await C.ensureProjectWorkset("acme-客户", "全新项目");
ok("rounds=0 无备份 → fresh", ws5.kind === "fresh", JSON.stringify(ws5) + ` rounds=${brand.rounds}`);

// —— 场景 4：会话分块（跨块追加只重写最后一块，恢复要拼得回来）——
const many = "长会话-";
for (let i = 0; i < 400; i++) {
  await C.appendConversation("acme-客户", "视频简历", { role: "customer", at: `t${i}`, text: many.repeat(200) + i });
}
const convKeys = [...kv.keys()].filter((k) => k.includes("视频简历/workset/conv/"));
ok("会话被切成多块（未塞进单个值）", convKeys.length > 1, `chunks=${convKeys.length}`);
await fs.rm(path.join(cwd, "clients", "acme-客户", "projects", "视频简历"), { recursive: true, force: true });
await C.ensureProjectWorkset("acme-客户", "视频简历");
const conv2 = await C.readConversation("acme-客户", "视频简历");
ok("跨块会话完整恢复（402 条）", conv2.length === 402, `len=${conv2.length}`);
ok("最后一条内容正确", conv2[401].text.endsWith("399"));

// —— 场景 5：文档备份在、会话备份丢（镜像半失败）→ 仍判 lost（零上文继续跑与全丢同类）——
const half = await C.createProject("acme-客户", "半丢项目", { name: "半丢", type: "doc" });
const halfDir = C.projectDir("acme-客户", "半丢项目");
await fs.writeFile(path.join(halfDir, "SPEC.md"), "# 半丢 SPEC\n真内容\n", "utf8");
await C.appendConversation("acme-客户", "半丢项目", { role: "customer", at: "t", text: "hi" });
await C.snapshotWorkset("acme-客户", "半丢项目");
await C.writeProjectState({ ...half, rounds: 2 });
await fs.rm(halfDir, { recursive: true, force: true });
for (const k of [...kv.keys()]) if (k.includes("半丢项目/workset/conv/")) kv.delete(k);
const ws6 = await C.ensureProjectWorkset("acme-客户", "半丢项目");
ok("文档在会话丢 → lost（不乐观判 restored）", ws6.kind === "lost", JSON.stringify(ws6));

server.close();
