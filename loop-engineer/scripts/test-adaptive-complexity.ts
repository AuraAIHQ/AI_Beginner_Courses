// CC-72 自适应:极简 spec → 1 个任务(single-shot);复杂 spec → 多任务。同一 planner,只看拆分粒度。
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadEnv, loadConfig } from "../src/config.js";
import { planSpec } from "../src/planner.js";

const SIMPLE = `## 一句话定位
一个纯前端待办清单网页。
## 目标用户与核心场景
个人用来记当天要做的事。
## 核心功能
1. 添加任务(输入框+按钮,回车或点击添加) —— 输入非空点添加后出现在列表
2. 打勾完成(每条可切换完成态,完成的划横线)
3. localStorage 持久化(刷新后仍在)
## 技术方向
纯 HTML+CSS+JS 单文件,无框架,无后端。
## 验收标准
打开页面能加、能勾、刷新不丢。
## 范围
范围外:多用户、云同步、截止日期。
`;

const COMPLEX = `## 一句话定位
一个多租户 SaaS 报销审批系统(员工提交、经理审批、财务打款)。
## 目标用户与核心场景
员工提交报销单并传发票;经理按团队看待审列表、批准/驳回;财务导出打款。
## 核心功能
1. 邮箱注册/登录 + 会话(三种角色:员工/经理/财务)
2. 报销单 CRUD + 发票图片上传(存对象存储)
3. 审批流状态机(草稿→提交→经理批→财务打款/驳回回退)
4. 经理看本团队待审列表 + 批量操作
5. 财务按月导出 CSV
6. 邮件通知(状态变更触发)
## 数据模型
User(role) / Expense(status,amount,ownerId) / Approval(expenseId,approverId,decision) / Attachment。
## 业务流程 / 状态机
草稿→提交→(经理)已批/已驳→(财务)已打款;驳回退回草稿。
## 错误处理与边界
越权审批拦截、金额上限、重复提交幂等。
## 技术方向
Next.js + Postgres + 鉴权 + 对象存储 + 邮件服务。
## 验收标准
三角色各自流程端到端可走通,越权被拦。
`;

async function planCount(name: string, spec: string, cfg: Awaited<ReturnType<typeof loadConfig>>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `adaptive-${name}-`));
  await fs.writeFile(path.join(dir, "SPEC.md"), spec, "utf8");
  console.log(`\n▸ [${name}] 调 planSpec...`);
  await planSpec(dir, cfg, { repo: "/tmp/fake-repo" });
  const m = JSON.parse(await fs.readFile(path.join(dir, "loop.json"), "utf8"));
  console.log(`  [${name}] → ${m.tasks.length} 个任务`);
  for (const t of m.tasks) console.log(`     ${t.id} ${t.title}`);
  await fs.rm(dir, { recursive: true, force: true });
  return m.tasks.length as number;
}

async function main() {
  loadEnv();
  const cfg = await loadConfig();
  const simpleN = await planCount("simple", SIMPLE, cfg);
  const complexN = await planCount("complex", COMPLEX, cfg);

  console.log(`\n=== 结果 ===\n极简 todo → ${simpleN} 任务  |  复杂 SaaS → ${complexN} 任务`);
  const problems: string[] = [];
  if (simpleN !== 1) problems.push(`极简应 1 个任务(single-shot),实得 ${simpleN}`);
  if (complexN < 3) problems.push(`复杂应多任务(≥3),实得 ${complexN}`);
  if (complexN <= simpleN) problems.push(`复杂任务数应 > 极简,实得 复杂${complexN} ≤ 极简${simpleN}`);
  if (problems.length) {
    console.error("\n✗ 自适应不达标:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
  console.log("\n🎉 自适应验证通过:极简走 single-shot(1 任务)、复杂充分拆分。");
}

main().catch((e) => {
  console.error("✗ 测试失败:", e);
  process.exit(1);
});
