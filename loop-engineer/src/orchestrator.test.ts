import assert from "node:assert/strict";
import test from "node:test";
import { resolveReviewerChain } from "./orchestrator.js";

/**
 * 回归（PR #63 review）：capabilities 重构漏了 resolveReviewerChain 这个调用点。
 * 它原先按 `kind !== "openai-chat"` 判「agentic reviewer 无需兜底链」，而本 PR 把 HiLinkup 的
 * kind 从 "openai-chat" 改成了 "openai-compatible" —— 条件由 false 翻成 true，HiLinkup 直接拿到
 * 空 fallbacks，等于静默删掉上一个 PR 专为 HiLinkup 429/额度耗尽加的 reviewer 降级链。
 * 判据必须是 capabilities.contextAccess。
 */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("HiLinkup reviewer keeps its fallback cascade (kind is openai-compatible, contextAccess inline)", () => {
  withEnv(
    {
      HILINKUP_API_KEY: "secret",
      HILINKUP_BASE_URL: "https://gateway.test/v1",
      DEEPSEEK_API_KEY: "ds-secret",
      LOOP_REVIEWER_FALLBACK: "deepseek-chat",
    },
    () => {
      const chain = resolveReviewerChain("hilinkup:model-x");
      assert.ok(chain, "chain should resolve");
      assert.equal(chain.provider.name, "hilinkup:model-x");
      assert.ok(
        chain.fallbacks.length > 0,
        "inline reviewer must keep a fallback cascade — an empty list silently disables 429/quota failover",
      );
      assert.equal(chain.fallbacks[0].name, "deepseek-chat");
    },
  );
});

test("agentic reviewer uses no chat fallback cascade", () => {
  withEnv({ ANTHROPIC_API_KEY: "sk-test", LOOP_REVIEWER_FALLBACK: "deepseek-chat" }, () => {
    const chain = resolveReviewerChain("mock");
    assert.ok(chain);
    assert.equal(chain.provider.capabilities.contextAccess, "agentic");
    assert.deepEqual(chain.fallbacks, []);
  });
});

test("unresolvable primary falls through to the fallback cascade", () => {
  withEnv(
    {
      HILINKUP_API_KEY: undefined, // 主档解析必失败
      DEEPSEEK_API_KEY: "ds-secret",
      LOOP_REVIEWER_FALLBACK: "deepseek-chat",
    },
    () => {
      const chain = resolveReviewerChain("hilinkup:model-x");
      assert.ok(chain);
      assert.equal(chain.provider.name, "deepseek-chat");
    },
  );
});
