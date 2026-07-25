import { createHmac } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { registerLifecycleSink, type LifecycleEvent } from "./lifecycle.js";
import { log } from "./log.js";

/**
 * W5 — 回调 webhook（契约 v2 · C2）。
 *
 * 把 job 生命周期事件（W4 的 lifecycle）POST 给 hack5 的 WORKBENCH_CALLBACK_URL，免其轮询。
 * 三道保障:
 *  - HMAC 签名（WORKBENCH_CALLBACK_SECRET）→ 防伪造 deployed 等事件;
 *  - 失败重试（429/5xx/网络错退避重试）;
 *  - 幂等键（同一逻辑事件稳定不变）→ hack5 可去重。
 *
 * body 按契约:{ event, clientSlug, projectSlug, repo, appUrl?, prUrl?, id }
 * header:x-workbench-signature: sha256=<hex>、x-workbench-idempotency-key: <id>
 */

const BACKOFF_MS = [1000, 3000, 8000];

export interface CallbackConfig {
  url?: string;
  secret?: string;
}

function loadConfig(): CallbackConfig {
  return {
    url: process.env.WORKBENCH_CALLBACK_URL,
    secret: process.env.WORKBENCH_CALLBACK_SECRET,
  };
}

/** 幂等键:同一逻辑事件（event+client+project+repo）稳定不变，供 hack5 去重（不含时间戳）。 */
export function idempotencyKey(evt: LifecycleEvent): string {
  const basis = `${evt.event}:${evt.clientSlug}:${evt.projectSlug}:${evt.repo}`;
  return createHmac("sha256", "workbench-idem-v1").update(basis).digest("hex").slice(0, 32);
}

/**
 * CC-60：失败摘要收敛为 ≤max 字的单行纯文本，供 hack5 存 build_error / 直接展示给用户。
 * 折叠空白（失败日志常含整段多行输出，见 server.ts 拼接 + gate failureLog），超长保留头部
 * （stage + 首个失败任务信息最有价值）并追加 `…(truncated)`，保证结果长度始终 ≤max。
 */
export function clampReason(s: string, max = 500): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const SUFFIX = "…(truncated)";
  return t.slice(0, max - SUFFIX.length).trimEnd() + SUFFIX;
}

/** 构造回调 body（稳定字段序,便于签名/校验）。导出供测试与 hack5 侧对齐。 */
export function callbackBody(evt: LifecycleEvent): string {
  return JSON.stringify({
    event: evt.event,
    clientSlug: evt.clientSlug,
    projectSlug: evt.projectSlug,
    repo: evt.repo,
    ...(evt.appUrl ? { appUrl: evt.appUrl } : {}),
    ...(evt.prUrl ? { prUrl: evt.prUrl } : {}),
    // CC-60：单 choke point 截断 error（不论来源:超时/异常/任务失败拼接），契约保证 ≤500 字。
    ...(evt.error ? { error: clampReason(evt.error) } : {}),
    ...(typeof evt.costUsd === "number" ? { costUsd: evt.costUsd } : {}),
    ...(typeof evt.inputTokens === "number" ? { inputTokens: evt.inputTokens } : {}),
    ...(typeof evt.outputTokens === "number" ? { outputTokens: evt.outputTokens } : {}),
    // 分节成本明细(每步花多少/积分/卡点),失败也带 —— durable 送达前端,不受容器回收影响。
    ...(evt.phases && evt.phases.length ? { phases: evt.phases } : {}),
    id: idempotencyKey(evt),
  });
}

/** 对 body 用共享密钥算 HMAC-SHA256 十六进制签名（hack5 侧同法验签）。 */
export function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * 发一个回调（HMAC 签名 + 重试）。url 未配 → no-op 返回 false。
 * 返回是否最终送达（2xx）。导出供测试直接调。
 */
export async function postCallback(
  evt: LifecycleEvent,
  cfg: CallbackConfig = loadConfig(),
): Promise<boolean> {
  if (!cfg.url) {
    log.info(`  未配 WORKBENCH_CALLBACK_URL，跳过回调（${evt.event}）`);
    return false;
  }
  const body = callbackBody(evt);
  const id = idempotencyKey(evt);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-workbench-idempotency-key": id,
  };
  if (cfg.secret) headers["x-workbench-signature"] = `sha256=${sign(body, cfg.secret)}`;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      const res = await fetch(cfg.url, { method: "POST", headers, body });
      if (res.ok) return true;
      // 429 / 5xx → 瞬时,退避重试;4xx（非 429）→ 客户端错,不重试
      if ((res.status === 429 || res.status >= 500) && attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      log.warn(`  回调 ${evt.event} HTTP ${res.status}，放弃`);
      return false;
    } catch (e) {
      if (attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      log.warn(`  回调 ${evt.event} 网络错，放弃:${(e as Error).message}`);
      return false;
    }
  }
  return false;
}

let installed = false;

/** 把回调 sink 挂到 lifecycle（server 启动时调一次，幂等）。 */
export function installCallbackSink(): void {
  if (installed) return;
  installed = true;
  registerLifecycleSink(async (evt) => {
    await postCallback(evt);
  });
  if (!process.env.WORKBENCH_CALLBACK_URL) {
    log.warn("未设 WORKBENCH_CALLBACK_URL —— 生命周期回调将被跳过（仅本地记录）。");
  }
}
