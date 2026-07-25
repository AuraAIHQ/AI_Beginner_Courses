import assert from "node:assert/strict";
import test from "node:test";
import { runToolLoop, type ChatCompletionRequest } from "./openai-compatible";

test("OpenAI-compatible agent executes tools until the model returns a final result", async () => {
  const requests: ChatCompletionRequest[] = [];
  const responses = [
    {
      choices: [{
        message: {
          role: "assistant" as const,
          content: "",
          tool_calls: [{
            id: "call-1",
            type: "function" as const,
            function: { name: "read_spec", arguments: '{"file":"SPEC.md"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    },
    {
      choices: [{ message: { role: "assistant" as const, content: '{"reply":"ready"}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 6 },
    },
  ];

  const result = await runToolLoop({
    baseUrl: "http://lm.test/v1",
    model: "local-model",
    system: "system",
    user: "user",
    tools: [{
      type: "function",
      function: {
        name: "read_spec",
        description: "Read a spec",
        parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
      },
    }],
    executeTool: async (name, input) => {
      assert.equal(name, "read_spec");
      assert.deepEqual(input, { file: "SPEC.md" });
      return "spec contents";
    },
    request: async (request) => {
      requests.push(request);
      return responses.shift()!;
    },
  });

  assert.equal(result.text, '{"reply":"ready"}');
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 10 });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1)?.role, "tool");
  assert.equal(requests[1].messages.at(-1)?.content, "spec contents");
});
