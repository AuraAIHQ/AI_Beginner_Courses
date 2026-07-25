import { log } from "./log.js";

/**
 * W4 — job 生命周期事件接缝（部署归 hack5、WorkBench 只回调）。
 *
 * 契约 v2 定稿:部署环归 hack5(C3:v1 仅静态 + CF Worker/Pages Functions),WorkBench **不持有
 * 部署凭据**。因此本模块只提供「job 编码完成 → 广播事件」的接缝:loop 侧在 coding 完成时发
 * `coding_done`,由 hack5 接手建仓/部署,再把 `deployed` 回给它自己的接收端。
 *
 * 事件的实际外发(HMAC 签名回调 + 重试 + 幂等)是 W5 —— W5 只需 registerLifecycleSink() 挂一个
 * webhook sink,不改这里。若未来真要 WorkBench 自部署,也只是再挂一个 deploy sink,接缝不变。
 */
export type LifecycleEventName = "loop_ready" | "coding_done" | "deployed" | "failed";

/**
 * 分节用量（每关键节点:planning / 各任务）。让前端(hack5 / fde-copilot)能展示
 * 「每一步花多少、卡在哪、该扣多少积分」,且随 coding_done/failed 回调 durable 送达
 * —— 不受 CF Container 回收丢日志影响。
 */
export interface PhaseUsage {
  /** 节点标识:"planning" | 任务 id(如 "T1")。 */
  stage: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** 展示用积分 = ceil(costUsd×100)。计费口径以事件级 costUsd 总额为准(逐节点 ceil 求和会略高于总额)。 */
  credits: number;
}

export interface LifecycleEvent {
  event: LifecycleEventName;
  clientSlug: string;
  projectSlug: string;
  repo: string;
  prUrl?: string;
  appUrl?: string;
  /** failed 事件的错误摘要（供 hack5 展示/记录；其它事件不带）。 */
  error?: string;
  /** CC-54：本 job 实际 token 成本(USD,按 hack5 权威价表逐模型算)。hack5 按 ceil(costUsd×100) 扣积分。 */
  costUsd?: number;
  /** CC-54：token 明细(便于 hack5 对账;可选)。 */
  inputTokens?: number;
  outputTokens?: number;
  /** 分节用量明细(planning + 各任务),供前端展示每步成本/积分/卡点。失败也带(已花即已计)。 */
  phases?: PhaseUsage[];
}

export type LifecycleSink = (evt: LifecycleEvent) => void | Promise<void>;

const sinks: LifecycleSink[] = [];

/** 注册一个生命周期 sink(W5 的 webhook 即挂于此)。返回注销函数。 */
export function registerLifecycleSink(sink: LifecycleSink): () => void {
  sinks.push(sink);
  return () => {
    const i = sinks.indexOf(sink);
    if (i >= 0) sinks.splice(i, 1);
  };
}

/** 仅供测试:清空所有 sink。 */
export function _resetLifecycleSinks(): void {
  sinks.length = 0;
}

/**
 * 触发一个生命周期事件,广播给所有 sink。各 sink 独立 try/catch,一个失败不影响其它,
 * 也不冒泡打断 loop —— 回调是「尽力而为」的旁路,不该拖垮编码闭环。
 */
export async function emitLifecycle(evt: LifecycleEvent): Promise<void> {
  log.info(
    `  生命周期:${evt.event} · ${evt.clientSlug}/${evt.projectSlug}` +
      `${evt.prUrl ? ` pr=${evt.prUrl}` : ""}${evt.appUrl ? ` app=${evt.appUrl}` : ""}`,
  );
  for (const sink of sinks) {
    try {
      await sink(evt);
    } catch (e) {
      log.warn(`  生命周期 sink 失败(${evt.event}):${(e as Error).message}`);
    }
  }
}
