import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * W1 状态持久化（契约 v2 · C1）。
 *
 * 此前 job 状态只在进程内内存(registry Map),server 重启即丢失、/status 无从查。
 * 这里把每个 job 的状态机快照落盘到其规格目录下 `.loop/status.json`(与 journal 同目录),
 * setState 时写、冷启动时读，从而重启后 /status 仍返回真实的最终状态 + prUrl/appUrl。
 */
const STATUS_FILE = path.join(".loop", "status.json");

export interface PersistedStatus {
  jobId: string;
  repo: string;
  clientSlug: string;
  projectSlug: string;
  state: string;
  prUrl?: string;
  appUrl?: string;
  error?: string;
  updatedAt: string;
  /** 累计用量 + 分节明细(供重启后 /status 仍显示成本/每步花费;结构对齐 server 的 Usage/PhaseUsage)。 */
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  phases?: Array<{ stage: string; costUsd: number; inputTokens: number; outputTokens: number; credits: number }>;
}

/** 把状态快照写入 specDir/.loop/status.json（原子:先写临时再 rename）。 */
export async function writeStatus(specDir: string, status: PersistedStatus): Promise<void> {
  const full = path.join(specDir, STATUS_FILE);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(status, null, 2) + "\n", "utf8");
  await fs.rename(tmp, full);
}

/** 读回状态快照;不存在/损坏 → null。 */
export async function readStatus(specDir: string): Promise<PersistedStatus | null> {
  try {
    const raw = await fs.readFile(path.join(specDir, STATUS_FILE), "utf8");
    const s = JSON.parse(raw) as PersistedStatus;
    if (!s.jobId || !s.state) return null;
    return s;
  } catch {
    return null;
  }
}
