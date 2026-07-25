import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocalCodingAgent, type LocalChatRequest } from "./local-agent.js";

test("LM Studio coding agent edits files inside its worktree", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "loop-local-"));
  await writeFile(path.join(cwd, "README.md"), "old\n", "utf8");
  const requests: LocalChatRequest[] = [];
  const responses = [
    {
      choices: [{ message: { role: "assistant" as const, content: "", tool_calls: [{
        id: "read-1", type: "function" as const,
        function: { name: "read_file", arguments: '{"path":"README.md"}' },
      }] } }],
    },
    {
      choices: [{ message: { role: "assistant" as const, content: "", tool_calls: [{
        id: "write-1", type: "function" as const,
        function: { name: "write_file", arguments: '{"path":"README.md","content":"new\\n"}' },
      }] } }],
    },
    { choices: [{ message: { role: "assistant" as const, content: "implemented" } }] },
  ];

  const out = await runLocalCodingAgent({
    cwd,
    baseUrl: "http://lm.test/v1",
    model: "local-coder",
    prompt: "Update README",
    request: async (body) => {
      requests.push(body);
      return responses.shift()!;
    },
  });

  assert.equal(out.text, "implemented");
  assert.equal(await readFile(path.join(cwd, "README.md"), "utf8"), "new\n");
  assert.equal(requests[1].messages.at(-1)?.role, "tool");
});

test("LM Studio coding agent cannot write outside its worktree", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "loop-local-"));
  const responses = [
    {
      choices: [{ message: { role: "assistant" as const, content: "", tool_calls: [{
        id: "write-1", type: "function" as const,
        function: { name: "write_file", arguments: '{"path":"../escape.txt","content":"bad"}' },
      }] } }],
    },
    { choices: [{ message: { role: "assistant" as const, content: "stopped" } }] },
  ];

  await runLocalCodingAgent({
    cwd,
    baseUrl: "http://lm.test/v1",
    model: "local-coder",
    prompt: "escape",
    request: async () => responses.shift()!,
  });

  await assert.rejects(readFile(path.resolve(cwd, "../escape.txt"), "utf8"));
});

test("LM Studio coding agent cannot write through a symlink outside its worktree", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "loop-local-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "loop-outside-"));
  const target = path.join(outside, "target.txt");
  await writeFile(target, "safe\n", "utf8");
  await symlink(target, path.join(cwd, "link.txt"));
  const responses = [
    {
      choices: [{ message: { role: "assistant" as const, content: "", tool_calls: [{
        id: "write-1", type: "function" as const,
        function: { name: "write_file", arguments: '{"path":"link.txt","content":"bad"}' },
      }] } }],
    },
    { choices: [{ message: { role: "assistant" as const, content: "stopped" } }] },
  ];

  await runLocalCodingAgent({
    cwd,
    baseUrl: "http://lm.test/v1",
    model: "local-coder",
    prompt: "escape",
    request: async () => responses.shift()!,
  });

  assert.equal(await readFile(target, "utf8"), "safe\n");
});
