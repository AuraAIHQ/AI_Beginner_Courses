// CC-58 · loop-engineer 的 Cloudflare Worker + Container 前置代理
//
// 形态：单例容器（in-memory job 队列/pool + 本地 worktree 必须命中同一实例）。
// Worker 只做透传——loop-engineer server.ts 自己校验 x-workbench-token（fail-closed），
// 故这里不重复鉴权，原样转发请求头即可（token auth passthrough）。
// 认证/回调等敏感值由 CF Secret 注入容器 env（默认云模式 EXECUTION_MODE=api，零本机订阅）。
import { Container, getContainer } from "@cloudflare/containers";

// 需要透传给容器的 secret/env 键（用 `wrangler secret put <KEY>` 配置；未配的自动跳过）
const PASSTHROUGH_KEYS = [
  "WORKBENCH_TOKEN", // 端点鉴权（fail-closed）
  "WORKBENCH_ALLOWED_ORIGINS", // CORS 白名单覆盖（可选）
  // —— 模型云 key（零 Anthropic 官方 key、零本机订阅）——
  "HILINKUP_API_KEY",
  "HILINKUP_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_MODEL",
  // —— W5 回调（把 build_state 推回 hack5）——
  "WORKBENCH_CALLBACK_URL",
  "WORKBENCH_CALLBACK_SECRET",
  // —— git 回推 & /deploy（CF Pages）——
  "WORKBENCH_PUSH_TOKEN",
  "LOOP_REPO_ROOT",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  // /deploy 专用的 CF Pages 凭据（thai-tea 账号,与 Workers-AI 的 CLOUDFLARE_* 隔离)。
  // cfCreds() 优先读这俩;漏配就落 CLOUDFLARE_* 兜底。此前未 passthrough → 设了 secret 也进不了容器 → /deploy 501。
  "PAGES_CF_TOKEN_THAI_TEA",
  "THAI_TEA_CLIENT_ID",
  // —— 并发/超时可调项（可选）——
  "LOOP_CONCURRENCY",
  "LOOP_JOB_TIMEOUT_MS",
] as const;

export interface Env {
  LOOP_ENGINEER: DurableObjectNamespace<LoopEngineerContainer>;
  [key: string]: unknown;
}

/** 从 Worker env（含 CF Secret）拼容器 env：固定云模式 + 绑 0.0.0.0，并入配置了的 secret。 */
function buildEnvVars(env: Env): Record<string, string> {
  const vars: Record<string, string> = {
    EXECUTION_MODE: "api",
    NODE_ENV: "production",
    LOOP_HTTP_HOST: "0.0.0.0",
    LOOP_HTTP_PORT: "4050",
    LOOP_WATCH_DIRS: "", // 云端只走 HTTP /plan，不用本地目录轮询
  };
  for (const k of PASSTHROUGH_KEYS) {
    const v = env[k];
    if (typeof v === "string" && v.length > 0) vars[k] = v;
  }
  return vars;
}

export class LoopEngineerContainer extends Container<Env> {
  defaultPort = 4050;
  requiredPorts = [4050];
  // 编码 job 可跑数分钟（默认 job 超时 30min）；设长于超时，避免任务中途被 sleep 掉。
  sleepAfter = "1h";
  enableInternet = true; // git clone/push、模型 API、CF 部署都要出站

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env);
    this.envVars = buildEnvVars(env);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 单例：所有 /plan /run /status /deploy 命中同一容器（共享 job 队列 + worktree 状态）。
    // Container.fetch 自动冷启并代理到 defaultPort；透传原始请求头（含 x-workbench-token）。
    return getContainer(env.LOOP_ENGINEER, "singleton").fetch(request);
  },
};
