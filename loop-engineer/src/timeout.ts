/**
 * 超时执行工具（契约 v2 · Q2:每 job/task 超时上限 → failed）。
 *
 * 超过 `ms` 就 abort `fn`(请它监听 signal 收手,如 kill 子进程),再给一段 `graceMs` 让它清理
 * worktree 后正常返回。**但 fn 若在 grace 内仍不收手(子进程挂死、abort 被忽略)→ 强制返回
 * timedOut,不再干等**（CC-63 根因:旧实现 `await fn` 会永远等一个不响应 abort 的挂死子进程,
 * 导致 job 永不到终态、W5 failed 回调永不发 → 僵尸单卡 reviewing 数小时)。
 *
 * 挂死的 fn promise 被 orphan(之后 resolve 是 no-op);其残留子进程/worktree 由调用方
 * best-effort 清理(server 的 pruneRepoWorktrees)。ms ≤ 0 或非有限 → 不设超时。
 */
export interface TimeoutResult<T> {
  timedOut: boolean;
  value?: T;
  error?: unknown;
}

export function runWithTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  graceMs = 30_000,
): Promise<TimeoutResult<T>> {
  const ctrl = new AbortController();
  const armed = Number.isFinite(ms) && ms > 0;
  return new Promise<TimeoutResult<T>>((resolve) => {
    let settled = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: TimeoutResult<T>): void => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(r);
    };
    // fn 正常结束/抛错:若是我们 abort 触发的抛错,标 timedOut;否则普通失败。
    fn(ctrl.signal).then(
      (value) => finish({ timedOut: false, value }),
      (error) => finish({ timedOut: ctrl.signal.aborted, error }),
    );
    if (armed) {
      hardTimer = setTimeout(() => {
        ctrl.abort(); // 请 fn 收手
        // grace 期:fn 收手就走上面的 then;不收手就强制 timedOut,绝不干等挂死的 fn。
        graceTimer = setTimeout(() => finish({ timedOut: true }), Math.max(0, graceMs));
      }, ms);
    }
  });
}
