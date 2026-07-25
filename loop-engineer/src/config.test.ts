import assert from "node:assert/strict";
import test from "node:test";
import { resolveProvider } from "./config.js";

test("LM Studio provider advertises chat and agentic coding capabilities", () => {
  const provider = resolveProvider("lmstudio:qwen-local", {
    LMSTUDIO_BASE_URL: "http://host.docker.internal:1234/v1",
  });

  assert.equal(provider.kind, "openai-compatible");
  assert.equal(provider.model, "qwen-local");
  assert.equal(provider.baseUrl, "http://host.docker.internal:1234/v1");
  assert.deepEqual(provider.capabilities, { chat: true, agenticCoder: true, contextAccess: "inline" });
});

test("OpenAI gateway remains chat-only", () => {
  const provider = resolveProvider("hilinkup:model-x", {
    HILINKUP_BASE_URL: "https://gateway.test/v1",
    HILINKUP_API_KEY: "secret",
  });

  assert.equal(provider.kind, "openai-compatible");
  assert.deepEqual(provider.capabilities, { chat: true, agenticCoder: false, contextAccess: "inline" });
});
