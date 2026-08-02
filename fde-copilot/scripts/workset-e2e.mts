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

// —— 场景 6（Codex review Blocking#1）：只有会话备份、没有文档备份 → lost，且**盘上不留半成品**，
//    否则下次调用 present 判据（conversation.jsonl 存在）会命中，409 静默退化成「继续在残缺工作集上跑」——
const conv只 = await C.createProject("acme-客户", "只有会话", { name: "只有会话", type: "doc" });
const conv只Dir = C.projectDir("acme-客户", "只有会话");
await C.appendConversation("acme-客户", "只有会话", { role: "customer", at: "t", text: "有历史的" });
await C.snapshotWorkset("acme-客户", "只有会话");
await C.writeProjectState({ ...conv只, rounds: 4 });
await fs.rm(conv只Dir, { recursive: true, force: true });
for (const k of [...kv.keys()]) if (k.includes("只有会话/workset/docs/")) kv.delete(k);
const ws7 = await C.ensureProjectWorkset("acme-客户", "只有会话");
ok("只有会话备份 → lost", ws7.kind === "lost", JSON.stringify(ws7));
ok("lost 时盘上零字节（不留半成品 conversation.jsonl）", ((await fs.readdir(conv只Dir).catch(() => [])) as string[]).length === 0);
const ws8 = await C.ensureProjectWorkset("acme-客户", "只有会话");
ok("再次调用仍是 lost（没被 present 误判绕过）", ws8.kind === "lost", JSON.stringify(ws8));

// —— 场景 7（Codex Blocking#2）：中间块缺失 → 整份判不可恢复，绝不把前缀当完整历史 ——
const 缺块 = await C.createProject("acme-客户", "缺块项目", { name: "缺块", type: "doc" });
await fs.writeFile(path.join(C.projectDir("acme-客户", "缺块项目"), "SPEC.md"), "# 有文档\n", "utf8");
for (let i = 0; i < 400; i++) {
  await C.appendConversation("acme-客户", "缺块项目", { role: "customer", at: `t${i}`, text: "长会话-".repeat(200) + i });
}
await C.snapshotWorkset("acme-客户", "缺块项目");
await C.writeProjectState({ ...缺块, rounds: 5 });
await fs.rm(C.projectDir("acme-客户", "缺块项目"), { recursive: true, force: true });
kv.delete([...kv.keys()].find((k) => k.includes("缺块项目/workset/conv/00001.jsonl"))!); // 打掉中间一块
const ws9 = await C.ensureProjectWorkset("acme-客户", "缺块项目");
ok("中间块缺失 → lost（不静默截断历史）", ws9.kind === "lost", JSON.stringify(ws9));

// —— 场景 8（Codex Blocking#2 后半）：reset 后块数变少，旧尾巴不得复活 ——
const ws10 = await C.ensureProjectWorkset("acme-客户", "缺块项目", { acceptLoss: true });
ok("reset 保留可恢复的文档（不把能救的扔掉）", ws10.kind === "reset" && ws10.restoredDocs > 0, JSON.stringify(ws10));
ok("reset 恢复的是文档真内容", (await C.readDoc("acme-客户", "缺块项目", "SPEC.md"))?.includes("有文档") === true);

await C.appendConversation("acme-客户", "缺块项目", { role: "customer", at: "new", text: "重建后的第一条" });
await fs.rm(C.projectDir("acme-客户", "缺块项目"), { recursive: true, force: true });
const ws11a = await C.ensureProjectWorkset("acme-客户", "缺块项目");
const conv3 = await C.readConversation("acme-客户", "缺块项目");
ok("reset 后块数变少，恢复只拿到新会话、旧尾巴没复活",
  ws11a.kind === "restored" && conv3.length === 1 && conv3[0].text === "重建后的第一条",
  `len=${conv3.length} kind=${ws11a.kind}`);

// —— 场景 9（Codex High#5）：单条超 1MB 的 entry 不能把整个项目的备份写挂 ——
const 巨大 = await C.createProject("acme-客户", "巨大条目", { name: "巨大", type: "doc" });
await C.appendConversation("acme-客户", "巨大条目", { role: "customer", at: "big", text: "啊".repeat(600_000) });
await C.snapshotWorkset("acme-客户", "巨大条目");
await C.writeProjectState({ ...巨大, rounds: 1 });
await fs.rm(C.projectDir("acme-客户", "巨大条目"), { recursive: true, force: true });
const ws11 = await C.ensureProjectWorkset("acme-客户", "巨大条目");
const conv4 = await C.readConversation("acme-客户", "巨大条目");
ok("超大 entry 仍能备份+恢复（占位替换而非写挂）", ws11.kind === "restored" && conv4.length === 1, JSON.stringify(ws11));
ok("占位如实说明被替换", conv4[0]?.text.includes("备份中已替换为占位") === true, conv4[0]?.text.slice(-30));

// —— 场景 10（Codex Medium#8）：损坏行不得让恢复吐出会 500 的会话 ——
const 坏行 = await C.createProject("acme-客户", "坏行项目", { name: "坏行", type: "doc" });
await fs.writeFile(path.join(C.projectDir("acme-客户", "坏行项目"), "SPEC.md"), "# doc\n", "utf8");
await C.appendConversation("acme-客户", "坏行项目", { role: "customer", at: "t", text: "正常" });
await C.snapshotWorkset("acme-客户", "坏行项目");
await C.writeProjectState({ ...坏行, rounds: 2 });
await fs.rm(C.projectDir("acme-客户", "坏行项目"), { recursive: true, force: true });
const 坏块 = [...kv.keys()].find((k) => k.includes("坏行项目/workset/conv/00000.jsonl"))!;
kv.set(坏块, kv.get(坏块)! + "{这不是合法 JSON\n");
const ws12 = await C.ensureProjectWorkset("acme-客户", "坏行项目");
ok("会话备份含损坏行 → lost（不把 500 埋进详情接口）", ws12.kind === "lost", JSON.stringify(ws12));

// —— 场景 11（Codex Blocking#3）：同项目并发必须串行，rounds/usage 不能互相覆盖 ——
const 并发 = await C.createProject("acme-客户", "并发项目", { name: "并发", type: "doc" });
const bump = () =>
  C.withProjectLock("acme-客户", "并发项目", async () => {
    const s = (await C.readProjectState("acme-客户", "并发项目"))!;
    await new Promise((r) => setTimeout(r, 5)); // 放大 read-modify-write 窗口
    await C.writeProjectState({ ...s, rounds: s.rounds + 1 });
  });
await Promise.all([bump(), bump(), bump(), bump(), bump()]);
const 并发后 = await C.readProjectState("acme-客户", "并发项目");
ok("5 个并发轮次一个不丢（锁生效）", 并发后?.rounds === 5, `rounds=${并发后?.rounds}（起始 ${并发.rounds}）`);

// —— 场景 12：agent 跑挂时回滚刚追加的客户输入（否则重试后历史里留两条一样的输入）——
const 回滚 = await C.createProject("acme-客户", "回滚项目", { name: "回滚", type: "doc" });
await C.appendConversation("acme-客户", "回滚项目", { role: "customer", at: "t1", text: "第一条" });
const 回滚点 = await C.conversationSize("acme-客户", "回滚项目");
await C.appendConversation("acme-客户", "回滚项目", { role: "customer", at: "t2", text: "agent 会挂的这条" });
await C.truncateConversation("acme-客户", "回滚项目", 回滚点);
const conv5 = await C.readConversation("acme-客户", "回滚项目");
ok("失败轮的孤儿输入已回滚", conv5.length === 1 && conv5[0].text === "第一条", `len=${conv5.length}`);
await C.writeProjectState({ ...回滚, rounds: 1 });
await fs.rm(C.projectDir("acme-客户", "回滚项目"), { recursive: true, force: true });
await C.ensureProjectWorkset("acme-客户", "回滚项目");
const conv6 = await C.readConversation("acme-客户", "回滚项目");
ok("备份也跟着回滚了（恢复出来不含孤儿条）", conv6.length === 1 && conv6[0].text === "第一条", `len=${conv6.length}`);

// —— 场景 13（Codex R2 Blocking#1）：并发恢复不得覆盖别人刚追加的内容（详情 GET 不进项目锁）——
const 并发恢复 = await C.createProject("acme-客户", "并发恢复", { name: "并发恢复", type: "doc" });
await fs.writeFile(path.join(C.projectDir("acme-客户", "并发恢复"), "SPEC.md"), "# 旧 SPEC\n", "utf8");
await C.appendConversation("acme-客户", "并发恢复", { role: "customer", at: "t0", text: "备份里的旧会话" });
await C.snapshotWorkset("acme-客户", "并发恢复");
await C.writeProjectState({ ...并发恢复, rounds: 1 });
await fs.rm(C.projectDir("acme-客户", "并发恢复"), { recursive: true, force: true });
// 模拟 chat：先恢复完并追加了新输入
await C.ensureProjectWorkset("acme-客户", "并发恢复");
await C.appendConversation("acme-客户", "并发恢复", { role: "customer", at: "t1", text: "chat 刚追加的新输入" });
// 模拟稍慢的并发 GET：此刻才走到落盘
await C.ensureProjectWorkset("acme-客户", "并发恢复");
const conv7 = await C.readConversation("acme-客户", "并发恢复");
ok("并发恢复没有把刚追加的输入盖掉", conv7.length === 2 && conv7[1].text === "chat 刚追加的新输入",
  `len=${conv7.length} last=${conv7[conv7.length - 1]?.text}`);

// —— 场景 14（Codex R2 Blocking#2）：备份标脏后，冷启不得把过期备份当成功恢复 ——
const 脏备份 = await C.createProject("acme-客户", "脏备份", { name: "脏备份", type: "doc" });
await fs.writeFile(path.join(C.projectDir("acme-客户", "脏备份"), "SPEC.md"), "# 第 1 轮\n", "utf8");
await C.appendConversation("acme-客户", "脏备份", { role: "customer", at: "t", text: "第 1 轮会话" });
await C.snapshotWorkset("acme-客户", "脏备份");
// 第 2 轮跑完但备份失败 → 落账 + 标脏（备份里仍是第 1 轮的内容）
await C.writeProjectState({ ...脏备份, rounds: 2, worksetBackupDirtyAt: "2026-08-02T04:00:00.000Z" });
await fs.rm(C.projectDir("acme-客户", "脏备份"), { recursive: true, force: true });
const ws13 = await C.ensureProjectWorkset("acme-客户", "脏备份");
ok("备份已知过期 → lost 而非静默退回上一轮", ws13.kind === "lost" && !!ws13.staleSince, JSON.stringify(ws13));
const ws14 = await C.ensureProjectWorkset("acme-客户", "脏备份", { acceptLoss: true });
ok("acceptLoss 后仍恢复旧文档，但横幅点明是更早一轮", ws14.kind === "reset" && ws14.restoredDocs > 0, JSON.stringify(ws14));
ok("横幅写明备份失败时刻", (await C.readDoc("acme-客户", "脏备份", "GAPS.md"))?.includes("最后一次备份失败于") === true);

// —— 场景 15（Codex R2 High#3）：回滚到空会话必须把 count 归零，否则旧块复活 ——
const 清空 = await C.createProject("acme-客户", "清空会话", { name: "清空", type: "doc" });
await C.appendConversation("acme-客户", "清空会话", { role: "customer", at: "t", text: "失败轮的那条输入" });
await C.truncateConversation("acme-客户", "清空会话", 0); // 回滚到空
await C.writeProjectState({ ...清空, rounds: 0 });
await fs.rm(C.projectDir("acme-客户", "清空会话"), { recursive: true, force: true });
await C.ensureProjectWorkset("acme-客户", "清空会话");
const conv8 = await C.readConversation("acme-客户", "清空会话");
ok("清空后恢复不出已撤销的那条", conv8.length === 0, `len=${conv8.length}`);

server.close();
