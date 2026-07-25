import { promises as fs } from "node:fs";
import path from "node:path";

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Resolve a path below root and reject symlinks that escape the project.
 * The returned path remains lexical so callers can create a missing file.
 */
export async function safeProjectPath(root: string, input: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(realRoot, input);
  if (!isInside(realRoot, candidate)) throw new Error(`路径越界：${input}`);

  try {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) throw new Error(`拒绝符号链接：${input}`);
    const realCandidate = await fs.realpath(candidate);
    if (!isInside(realRoot, realCandidate)) throw new Error(`符号链接越界：${input}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    let ancestor = path.dirname(candidate);
    while (true) {
      try {
        const realAncestor = await fs.realpath(ancestor);
        if (!isInside(realRoot, realAncestor)) throw new Error(`父目录越界：${input}`);
        break;
      } catch (ancestorError) {
        if ((ancestorError as NodeJS.ErrnoException).code !== "ENOENT") throw ancestorError;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw ancestorError;
        ancestor = parent;
      }
    }
  }
  return candidate;
}
