import { z } from "zod";

// —— 任务与 Job 契约（loop.json）——

export const TaskStatus = z.enum([
  "todo",
  "in_progress",
  "done",
  "failed",
  "blocked",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  /** 给 worker 的实现说明（应足够独立，下游零上下文可开工） */
  spec: z.string(),
  /** 验收标准，最好 Given/When/Then，可转成测试 */
  acceptance: z.array(z.string()).default([]),
  /** 建议改动的文件/范围（可选提示） */
  files: z.array(z.string()).default([]),
  /** 依赖的其他任务 id（都 done 才可开工） */
  dependsOn: z.array(z.string()).default([]),
  status: TaskStatus.default("todo"),
  attempts: z.number().default(0),
  /** 该任务的工作分支名（运行时写入） */
  branch: z.string().optional(),
  /** 最近一次结果摘要 */
  lastResult: z.string().optional(),
  /** per-task 模型路由：难任务可覆盖 coder/reviewer 供应商（不填用全局默认） */
  coderProvider: z.string().optional(),
  reviewerProvider: z.string().optional(),
});
export type Task = z.infer<typeof Task>;

export const VerifyConfig = z.object({
  /** 一次性安装命令，worktree 建好后跑一次 */
  install: z.string().optional(),
  /** 质量闸命令，全部退出码 0 才算过（typecheck/test/build/lint） */
  commands: z.array(z.string()).default([]),
});
export type VerifyConfig = z.infer<typeof VerifyConfig>;

export const JobManifest = z.object({
  id: z.string(),
  /** 目标 repo 路径（相对 job 目录或绝对路径），必须是 git 仓库 */
  repo: z.string(),
  baseBranch: z.string().default("main"),
  /** 合并目标：任务 PR 自动并到这个集成分支，人守主干 */
  integrationBranch: z.string().default("loop/integration"),
  verify: VerifyConfig.default({ commands: [] }),
  tasks: z.array(Task).default([]),
});
export type JobManifest = z.infer<typeof JobManifest>;

// —— 运行时 ——

export const Config = z.object({
  watchDirs: z.array(z.string()).default([]),
  pollIntervalMs: z.number().default(15000),
  maxAttempts: z.number().default(3),
  providers: z
    .object({
      planner: z.string().default("claude"),
      coder: z.string().default("glm"),
      reviewer: z.string().default("kimi"),
      /** 可选外层 reviewer（如 deepseek）：内层过后再独立审一遍，双过才 merge */
      outerReviewer: z.string().optional(),
    })
    .default({ planner: "claude", coder: "glm", reviewer: "kimi" }),
});
export type Config = z.infer<typeof Config>;

/** reviewer 的结构化裁决 */
export interface ReviewVerdict {
  approved: boolean;
  score: number; // 0-100
  blocking: string[]; // 必须修的问题
  suggestions: string[]; // 非阻塞建议
  summary: string;
}

/** 一个 job（loaded manifest + 其磁盘位置） */
export interface LoadedJob {
  manifest: JobManifest;
  jobDir: string; // loop.json 所在目录
  manifestPath: string;
  repoPath: string; // 解析后的绝对 repo 路径（远程仓时 = job 目录下的本地 clone 路径）
  /** manifest.repo 是远程 URL 时的原始远程地址（本地路径仓为 undefined）。 */
  remoteUrl?: string;
}
