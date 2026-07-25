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
