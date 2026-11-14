import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isPathInsideDirectory } from "./recording";

export type ArticlePreviewFrame = {
  timeSeconds: number;
  imageBase64: string;
};

export type ArticlePreviewFields = {
  videoPreviewAvailable: true;
  videoPreviewTimeSeconds: number;
  videoPreviewUpdatedAt: string;
  videoPreviewDataUrl: string;
};

const MAX_PREVIEW_BYTES = 3_000_000;
const ARTICLE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

function getPreviewPath(directoryInput: string, articleId: string): string {
  if (!ARTICLE_ID_PATTERN.test(articleId)) {
    throw new Error("記事IDが不正なため、放送画面を保存できません。");
  }
  const directory = resolve(directoryInput);
  const filePath = join(directory, articleId + ".preview.jpg");
  if (!isPathInsideDirectory(filePath, directory)) {
    throw new Error("放送画面の保存先が記事フォルダーの外側です。");
  }
  return filePath;
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 100 &&
    buffer[0] === 0xff && buffer[1] === 0xd8 &&
    buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
}

function asDataUrl(buffer: Buffer): string {
  return "data:image/jpeg;base64," + buffer.toString("base64");
}

export function saveArticlePreviewFrame(
  directoryInput: string,
  articleId: string,
  frame: ArticlePreviewFrame
): ArticlePreviewFields {
  if (!frame || !Number.isFinite(frame.timeSeconds) || frame.timeSeconds < 0 ||
      typeof frame.imageBase64 !== "string" || frame.imageBase64.length < 100 ||
      frame.imageBase64.length > Math.ceil(MAX_PREVIEW_BYTES * 4 / 3) + 8 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.imageBase64)) {
    throw new Error("放送画面の画像データが不正です。");
  }

  const buffer = Buffer.from(frame.imageBase64, "base64");
  if (buffer.length > MAX_PREVIEW_BYTES || !isJpeg(buffer)) {
    throw new Error("放送画面のJPEG画像を保存できません（サイズまたは形式が不正です）。");
  }

  const filePath = getPreviewPath(directoryInput, articleId);
  const temporaryPath = filePath + ".tmp";
  mkdirSync(resolve(directoryInput), { recursive: true });
  try {
    writeFileSync(temporaryPath, buffer);
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try { if (existsSync(temporaryPath)) unlinkSync(temporaryPath); } catch { /* best-effort cleanup */ }
    throw error;
  }

  return {
    videoPreviewAvailable: true,
    videoPreviewTimeSeconds: Math.max(0, Math.floor(frame.timeSeconds)),
    videoPreviewUpdatedAt: new Date().toISOString(),
    videoPreviewDataUrl: asDataUrl(buffer)
  };
}

export function readArticlePreviewDataUrl(directoryInput: string, articleId: string): string | undefined {
  let filePath: string;
  try { filePath = getPreviewPath(directoryInput, articleId); } catch { return undefined; }
  if (!existsSync(filePath)) return undefined;
  try {
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size < 100 || stats.size > MAX_PREVIEW_BYTES) return undefined;
    const buffer = readFileSync(filePath);
    return isJpeg(buffer) ? asDataUrl(buffer) : undefined;
  } catch {
    return undefined;
  }
}

export function deleteArticlePreview(directoryInput: string, articleId: string): void {
  const filePath = getPreviewPath(directoryInput, articleId);
  const temporaryPath = filePath + ".tmp";
  if (existsSync(filePath)) unlinkSync(filePath);
  if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
}
