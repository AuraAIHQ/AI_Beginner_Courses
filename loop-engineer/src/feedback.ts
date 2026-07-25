import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";
import { resolveProvider } from "./config.js";
import { runAgent, runChat, extractJson } from "./providers.js";
import { appendJournal } from "./jobs.js";
import type { Config, LoadedJob, Task } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface BlockedOut {
  kind: "spec_gap" | "impl_only";
  question: string;
  why: string;
  hypotheses: string[];
  summary: string;
}

async function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

/** 读若干规格文件拼成一段（供无工具的 chat 供应商） */
async function readSome(dir: string, files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const f of files) {
    try {
      parts.push(`### ${f}\n${await fs.readFile(path.join(dir, f), "utf8")}`);
    } catch {
      /* skip */
    }
  }
  return parts.join("\n\n") || "（无）";
}

/**
 * v0.2 失败回流：任务反复失败后，把技术失败翻译成面向客户的澄清问题，
 * 回写到规格目录的 GAPS.md（与 fde-copilot 同一份台账），闭合
 * 「实现受阻 → 反问客户 → 补规格 → 再实现」的飞轮。
 */
export async function reportBlocked(
  job: LoadedJob,
  task: Task,
  failure: string,
  config: Config,
): Promise<void> {
  const planner = resolveProvider(config.providers.planner);
  const tpl = await fs.readFile(path.join(__dirname, "..", "prompts", "blocked.md"), "utf8");

  const taskBlock = [
    `- ID：${task.id}`,
    `- 标题：${task.title}`,
    `- 说明：${task.spec}`,
    `- 验收：${task.acceptance.join("；") || "（无）"}`,
    `- 已尝试次数：${task.attempts}`,
  ].join("\n");

  const prompt = tpl
    .replace("{{TASK_BLOCK}}", taskBlock)
    .replace("{{FAILURE_BLOCK}}", failure.slice(0, 6000));

  let out: BlockedOut | null = null;
  try {
    let text: string;
    if (planner.capabilities.contextAccess === "inline") {
      const spec = await readSome(job.jobDir, ["SPEC.md", "FEATURES.md", "GAPS.md"]);
      text = (await runChat(prompt, `## 相关规格\n\n${spec}`, { provider: planner })).text;
    } else {
      const res = await runAgent(prompt, {
        cwd: job.jobDir,
        provider: planner,
        allowedTools: ["Read", "Grep", "Glob"],
        mockHandler: planner.isMock
          ? async () =>
              JSON.stringify({
                kind: "spec_gap",
                question: `任务「${task.title}」实现受阻，请确认相关规格是否完整`,
                why: failure.slice(0, 200),
                hypotheses: [],
                summary: "[mock] 回流",
              } satisfies BlockedOut)
          : undefined,
      });
      text = res.text;
    }
    out = extractJson<BlockedOut>(text);
  } catch (e) {
    log.warn(`回流生成失败，用兜底：${(e as Error).message}`);
  }

  // 兜底：planner 没给结构化结果就用确定性模板
  if (!out) {
    out = {
      kind: "spec_gap",
      question: `任务「${task.title}」连续 ${task.attempts} 次实现失败，请检查该 feature 的验收标准与技术前提是否明确/可行。`,
      why: "自主循环无法在规格现状下完成，疑似规格缺口。",
      hypotheses: [],
      summary: "实现受阻，需澄清",
    };
  }

  if (out.kind === "impl_only") {
    log.warn(`  回流判定为纯实现问题（非规格缺口），不打扰客户；详情入 journal`);
    await appendJournal(job, task.id, `回流：纯实现问题——${out.summary}`);
    return;
  }

  // 写回 GAPS.md（若存在，追加"实现受阻"区）；否则写 .loop/blocked.md
  const at = new Date().toISOString().slice(0, 16).replace("T", " ");
  const entry = [
    ``,
    `### [${task.id}] ${task.title} — 实现受阻·待澄清（Loop-Engineer 回流 ${at}）`,
    `- **问题**：${out.question}`,
    `- **为什么卡住**：${out.why}`,
    out.hypotheses.length ? `- **我的猜测（待你确认）**：\n${out.hypotheses.map((h) => `    - ${h}`).join("\n")}` : "",
    `- **失败摘要**：${failure.slice(0, 300).replace(/\n/g, " ")}`,
    ``,
  ]
    .filter(Boolean)
    .join("\n");

  const gaps = path.join(job.jobDir, "GAPS.md");
  if (await fileExists(gaps)) {
    let content = await fs.readFile(gaps, "utf8");
    const marker = "## 实现受阻·待澄清（来自 Loop-Engineer）";
    if (!content.includes(marker)) content += `\n\n${marker}\n`;
    content = content.replace(marker, `${marker}\n${entry}`);
    await fs.writeFile(gaps, content, "utf8");
    log.warn(`  ↩ 已回流到 ${gaps}：${out.question}`);
  } else {
    const dir = path.join(job.jobDir, ".loop");
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, "blocked.md"), entry, "utf8");
    log.warn(`  ↩ 无 GAPS.md，已写 .loop/blocked.md：${out.question}`);
  }
  await appendJournal(job, task.id, `↩ 回流客户：${out.question}`);
}
