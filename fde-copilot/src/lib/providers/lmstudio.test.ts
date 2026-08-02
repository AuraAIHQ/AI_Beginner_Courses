import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLmStudioSpecAgent } from "./lmstudio";

test("LM Studio spec agent updates only spec documents and submits a structured turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fde-lmstudio-"));
  await writeFile(path.join(root, "SPEC.md"), "# old\n", "utf8");
  const responses = [
    {
      choices: [{
        message: {
          role: "assistant" as const,
          content: "",
          tool_calls: [
            {
              id: "write-1", type: "function" as const,
              function: { name: "write_spec", arguments: '{"file":"SPEC.md","content":"# updated\\n"}' },
            },
            {
              id: "submit-1", type: "function" as const,
              function: {
                name: "submit_turn",
                arguments: JSON.stringify({
                  reply: "已更新需求规格",
                  open_questions: [],
                  research_notes: [],
                  readiness: { score: 80, loop_ready: false, missing: ["验收数据"] },
                  updated_docs: ["SPEC.md"],
                }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      }],
    },
    { choices: [{ message: { role: "assistant" as const, content: "done" }, finish_reason: "stop" }] },
  ];

  const out = await runLmStudioSpecAgent({
    root,
    model: "local-model",
    baseUrl: "http://lm.test/v1",
    system: "system",
    user: "user",
    request: async () => responses.shift()!,
  });

  assert.equal(await readFile(path.join(root, "SPEC.md"), "utf8"), "# updated\n");
  assert.equal(out.result.reply, "已更新需求规格");
  assert.equal(out.result.readiness.score, 80);
  assert.equal(out.usedFallback, false);
});

test("LM Studio spec agent rejects writes outside the spec allowlist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fde-lmstudio-"));
  const responses = [
    {
      choices: [{
        message: {
          role: "assistant" as const,
          content: "",
          tool_calls: [{
            id: "write-1", type: "function" as const,
            function: { name: "write_spec", arguments: '{"file":"../escape.md","content":"bad"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    },
    { choices: [{ message: { role: "assistant" as const, content: "stopped" }, finish_reason: "stop" }] },
  ];

  await runLmStudioSpecAgent({
    root,
    model: "local-model",
    baseUrl: "http://lm.test/v1",
    system: "system",
    user: "user",
    request: async () => responses.shift()!,
  });

  await assert.rejects(readFile(path.join(root, "..", "escape.md"), "utf8"));
});

test("LM Studio spec agent rejects an allowlisted document symlinked outside the project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fde-lmstudio-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "fde-outside-"));
  const target = path.join(outside, "target.md");
  await writeFile(target, "# safe\n", "utf8");
  await symlink(target, path.join(root, "SPEC.md"));
  const responses = [
    {
      choices: [{
        message: {
          role: "assistant" as const,
          content: "",
          tool_calls: [{
            id: "write-1", type: "function" as const,
            function: { name: "write_spec", arguments: '{"file":"SPEC.md","content":"# bad\\n"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    },
    { choices: [{ message: { role: "assistant" as const, content: "stopped" }, finish_reason: "stop" }] },
  ];

  await runLmStudioSpecAgent({
    root,
    model: "local-model",
    baseUrl: "http://lm.test/v1",
    system: "system",
    user: "user",
    request: async () => responses.shift()!,
  });

  assert.equal(await readFile(target, "utf8"), "# safe\n");
});

/**
 * 回归（PR #63 review）：fastMode 的 prompt 让模型「把完整 SPEC.md 放进 submit_turn 的
 * spec_markdown 字段，server 会替你写盘」，但 LM Studio 的 submit_turn schema 里根本没有这个字段
 * （zod 非 strict 会静默 strip），server 端也没有对应的写盘 fallback —— 模型照做等于白写，
 * 而 fastMode 是默认路径（CHAT_FULL_SPEC 未设即启用）。
 */
test("LM Studio spec agent writes back spec_markdown from submit_turn (fastMode path)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fde-lmstudio-"));
  await writeFile(path.join(root, "SPEC.md"), "# old\n", "utf8");
  const responses = [
    {
      choices: [{
        message: {
          role: "assistant" as const,
          content: "",
          tool_calls: [{
            id: "submit-1", type: "function" as const,
            function: {
              name: "submit_turn",
              arguments: JSON.stringify({
                reply: "已更新",
                open_questions: [],
                research_notes: [],
                readiness: { score: 70, loop_ready: false, missing: [] },
                updated_docs: [],
                spec_markdown: "# 快 chat 写回的全文",
              }),
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
    },
    { choices: [{ message: { role: "assistant" as const, content: "done" }, finish_reason: "stop" }] },
  ];

  const out = await runLmStudioSpecAgent({
    root,
    model: "local-model",
    baseUrl: "http://lm.test/v1",
    system: "system",
    user: "user",
    request: async () => responses.shift()!,
  });

  assert.equal(await readFile(path.join(root, "SPEC.md"), "utf8"), "# 快 chat 写回的全文\n");
  assert.equal(out.usedFallback, false);
  assert.ok(out.result.updated_docs.includes("SPEC.md"), "写盘后应把 SPEC.md 记进 updated_docs");
});

/**
 * 回归（PR #63 review）：工具回合用尽时 runToolLoop 原本直接抛错，把模型**已经提交并已写盘**的
 * 结果一并丢掉，违反本 provider「失败要优雅降级、不要抛」的既有约定；LM Studio 又继承了 fastMode
 * 的 4 轮预算，read→write→submit 正好吃干净。现在改为如实返回 exhausted，由调用方判定。
 */
test("LM Studio spec agent keeps an already-submitted result when turns run out", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fde-lmstudio-"));
  await writeFile(path.join(root, "SPEC.md"), "# old\n", "utf8");
  // 每一轮都回工具调用，永远不给收尾回复 → 必然耗尽 maxTurns
  const submitCall = {
    choices: [{
      message: {
        role: "assistant" as const,
        content: "",
        tool_calls: [{
          id: "submit-1", type: "function" as const,
          function: {
            name: "submit_turn",
            arguments: JSON.stringify({
              reply: "结果在这里，别丢",
              open_questions: [],
              research_notes: [],
              readiness: { score: 60, loop_ready: false, missing: [] },
              updated_docs: ["SPEC.md"],
            }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  };

  const out = await runLmStudioSpecAgent({
    root,
    model: "local-model",
    baseUrl: "http://lm.test/v1",
    system: "system",
    user: "user",
    maxTurns: 2,
    request: async () => submitCall,
  });

  assert.equal(out.result.reply, "结果在这里，别丢");
  assert.equal(out.usedFallback, false);
  assert.equal(out.usage.turns, 2, "usage.turns 应是真实回合数，不是硬编码 1");
});

test("LM Studio spec agent degrades gracefully when turns run out with nothing submitted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fde-lmstudio-"));
  const listCall = {
    choices: [{
      message: {
        role: "assistant" as const,
        content: "",
        tool_calls: [{
          id: "list-1", type: "function" as const,
          function: { name: "list_specs", arguments: "{}" },
        }],
      },
      finish_reason: "tool_calls",
    }],
  };

  // 关键：不抛错（此前是 throw，整轮 500）
  const out = await runLmStudioSpecAgent({
    root,
    model: "local-model",
    baseUrl: "http://lm.test/v1",
    system: "system",
    user: "user",
    maxTurns: 2,
    request: async () => listCall,
  });

  assert.equal(out.usedFallback, true);
  assert.match(out.result.readiness.missing[0], /回合用尽/);
});
