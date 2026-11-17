import { lstatSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

/**
 * Delete only a JSONL comment log that actually appears in Chat/<kick-slug>/.
 * Do not allow deleting arbitrary files from a renderer-provided pathname,
 * symlinks, other files in the library, or entire directories.
 */
export function validateCommentLogForDeletion(outputDirectory: string, inputPath: unknown): string {
  if (typeof inputPath !== "string" || inputPath.length < 1 || inputPath.length > 4096) {
    throw new Error("削除するコメントログの場所が正しくありません。");
  }
  const chatRoot = resolve(outputDirectory, "Chat");
  const target = resolve(inputPath);
  const channelDirectory = dirname(target);
  const slug = basename(channelDirectory);
  const fileName = basename(target);

  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(slug) ||
      !fileName || fileName === "." || fileName === ".." ||
      extname(fileName).toLowerCase() !== ".jsonl" ||
      channelDirectory !== join(chatRoot, slug) ||
      !target.startsWith(chatRoot + sep)) {
    throw new Error("コメントログ以外のファイルは削除できません。");
  }

  try {
    const rootStats = lstatSync(chatRoot);
    const channelStats = lstatSync(channelDirectory);
    const targetStats = lstatSync(target);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink() ||
        !channelStats.isDirectory() || channelStats.isSymbolicLink() ||
        !targetStats.isFile() || targetStats.isSymbolicLink()) {
      throw new Error("通常のコメントログ以外は削除できません。");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("通常のコメントログ")) throw error;
    throw new Error("コメントログが見つからないか、すでに削除されています。");
  }
  return target;
}

export async function trashCommentLogFile(
  outputDirectory: string,
  inputPath: unknown,
  isActive: (filePath: string) => boolean,
  trash: (filePath: string) => Promise<void>
): Promise<{ ok: true; name: string }> {
  const target = validateCommentLogForDeletion(outputDirectory, inputPath);
  if (isActive(target)) {
    throw new Error("コメント取得中のファイルは削除できません。取得を停止してから削除してください。");
  }
  await trash(target);
  return { ok: true, name: basename(target) };
}
