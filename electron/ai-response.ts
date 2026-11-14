type UnknownRecord = Record<string, unknown>;
export type AiArticleAnalysis = {
 headline: string; summary: string; paragraphs: string[]; highlights: string[];
 keywords: string[]; videoSummary: string; videoScenes: string[]; audioSummary: string;
};
function asRecord(value: unknown): UnknownRecord | null {
 return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}
function readText(value: unknown, depth = 0): string {
 if (typeof value === "string") return value;
 if (depth > 5) return "";
 if (Array.isArray(value)) return value.map(item => readText(item, depth + 1)).filter(Boolean).join("\n");
 const record = asRecord(value);
 if (!record || record.type === "refusal" || typeof record.refusal === "string") return "";
 if (typeof record.text === "string" && record.text.trim()) return record.text;
 for (const key of ["content", "parts", "response", "output_text", "output"]) {
  const found = readText(record[key], depth + 1);
  if (found.trim()) return found;
 }
 return "";
}
function extractInner(payload: UnknownRecord, depth = 0): string {
 if (depth > 4) return "";
 if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
 if (Array.isArray(payload.output)) {
  const found = payload.output.map(item => {
   const record = asRecord(item);
   return record ? (readText(record.content) || readText(record.text)) : "";
  }).filter(Boolean);
  if (found.length) return found.join("\n").trim();
 }
 const message = asRecord(payload.message);
 if (message) {
  const found = readText(message.content);
  if (found.trim()) return found.trim();
 }
 const choices = Array.isArray(payload.choices) ? payload.choices : [];
 for (const item of choices) {
  const choice = asRecord(item);
  if (!choice) continue;
  const messageRecord = asRecord(choice.message) ?? asRecord(choice.delta);
  const found = messageRecord ? readText(messageRecord.content) : "";
  if (found.trim()) return found.trim();
  if (typeof choice.text === "string" && choice.text.trim()) return choice.text.trim();
 }
 const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
 for (const item of candidates) {
  const candidate = asRecord(item);
  const content = asRecord(candidate?.content);
  const found = readText(content?.parts ?? content);
  if (found.trim()) return found.trim();
 }
 for (const key of ["response", "content", "text", "result", "data"]) {
  const item = payload[key];
  if (typeof item === "string" && item.trim()) return item.trim();
  const nested = asRecord(item);
  if (nested) {
   const found = extractInner(nested, depth + 1);
   if (found.trim()) return found.trim();
  }
 }
 return "";
}
export function extractAiResponseText(payload: UnknownRecord): string {
 return extractInner(payload);
}
export function describeEmptyAiResponse(payload: UnknownRecord): string {
 const status = typeof payload.status === "string" ? payload.status : "";
 const details = asRecord(payload.incomplete_details);
 const reason = typeof details?.reason === "string" ? details.reason : "";
 const error = asRecord(payload.error);
 const errorCode = typeof error?.code === "string" ? error.code : "";
 const errorMessage = typeof error?.message === "string" ? error.message : "";
 const message = asRecord(payload.message);
 const doneReason = typeof message?.done_reason === "string" ? message.done_reason : "";
 const choices = Array.isArray(payload.choices) ? payload.choices : [];
 const finishReasons = choices.map(item => {
  const choice = asRecord(item);
  return typeof choice?.finish_reason === "string" ? choice.finish_reason : "";
 }).filter(Boolean);
 const usage = asRecord(payload.usage);
 const outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined;
 const refusal = Array.isArray(payload.output) && payload.output.some(item => {
  const record = asRecord(item);
  return Boolean(record && Array.isArray(record.content) && record.content.some(part => {
   const content = asRecord(part);
   return Boolean(content && (content.type === "refusal" || typeof content.refusal === "string"));
  }));
 });
 if (refusal) return "AIモデルが記事生成を拒否したため、記事本文を取得できませんでした。AIモデルの設定と送信内容を確認してください。";
 const diagnostics = [
  status ? "status=" + status : "", reason ? "reason=" + reason : "",
  doneReason ? "done_reason=" + doneReason : "",
  finishReasons.length ? "finish_reason=" + finishReasons.join(",") : "",
  outputTokens !== undefined ? "output_tokens=" + outputTokens : "",
  errorCode ? "error=" + errorCode : "", errorMessage ? errorMessage.slice(0, 180) : ""
 ].filter(Boolean);
 if (diagnostics.length) return "AI応答に記事本文が含まれていません（" + diagnostics.join(" / ") + "）。出力上限・応答形式・モデル設定を確認してください。";
 return "AIサービスから応答は届きましたが、記事本文として読めるテキストがありません。Ollamaの応答形式、またはOpenAIの応答状態と出力上限を確認してください。";
}
export function normalizeAiJsonText(input: string): string {
 let value = input.replace(/^\uFEFF/, "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
 const fence = value.match(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i);
 if (fence) value = fence[1].trim();
 else {
  const fences = [...value.matchAll(/\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}/gi)];
  const candidate = fences.find(item => /^\s*\{/.test(item[1]));
  if (candidate) value = candidate[1].trim();
 }
 const start = value.indexOf("{");
 if (start < 0) return value;
 let depth = 0, inString = false, escaped = false;
 for (let i = start; i < value.length; i++) {
  const c = value[i];
  if (inString) {
   if (escaped) escaped = false;
   else if (c === "\\") escaped = true;
   else if (c === "\"") inString = false;
  } else if (c === "\"") inString = true;
  else if (c === "{") depth++;
  else if (c === "}" && --depth === 0) return value.slice(start, i + 1);
 }
 return value;
}
function safeString(value: unknown, max: number): string {
 return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function firstString(record: UnknownRecord, keys: string[], max: number): string {
 for (const key of keys) {
  const value = safeString(record[key], max);
  if (value) return value;
 }
 return "";
}
function splitBody(value: string): string[] {
 const text = value.trim().slice(0, 12000);
 if (!text) return [];
 const paragraphs = text.split(/\r?\n\s*\r?\n|\r?\n/).map(item => item.trim()).filter(Boolean);
 if (paragraphs.length > 1) return paragraphs.slice(0, 5).map(item => item.slice(0, 1000));
 return [text.slice(0, 1000)];
}
function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
 if (typeof value === "string") return splitBody(value).slice(0, maxItems);
 if (!Array.isArray(value)) return [];
 return value.filter((item): item is string => typeof item === "string").map(item => item.trim().slice(0, maxLength)).filter(Boolean).slice(0, maxItems);
}
function plainTextArticle(raw: string, fallback: string): AiArticleAnalysis {
 const cleaned = raw.replace(/^\s*(?:記事本文|本文|記事|article)\s*[:：]\s*/i, "").trim();
 const title = cleaned.match(/^(?:見出し|タイトル|headline)\s*[:：]\s*(.+)$/im);
 const paragraphs = splitBody(cleaned.replace(/^(?:見出し|タイトル|headline)\s*[:：].+\r?\n?/im, ""));
 if (!paragraphs.length) throw new Error("AI応答に記事本文として利用できる文章がありません。");
 return {
  headline: title?.[1]?.trim().slice(0, 160) || fallback || "配信AI新聞",
  summary: paragraphs[0].slice(0, 500), paragraphs, highlights: [], keywords: [],
  videoSummary: "", videoScenes: [], audioSummary: ""
 };
}
export function parseAiArticleResponse(payload: UnknownRecord, fallbackHeadline = "配信AI新聞"): AiArticleAnalysis {
 const raw = extractAiResponseText(payload);
 if (!raw) throw new Error(describeEmptyAiResponse(payload));
 const normalized = normalizeAiJsonText(raw);
 let parsed: unknown;
 try { parsed = JSON.parse(normalized); }
 catch {
  if (/^\s*\{/.test(normalized)) throw new Error("AIから文章は返されましたが、記事JSONの形式が途中で切れているか不正です。出力上限とモデルのJSON出力設定を確認してください。");
  return plainTextArticle(normalized, safeString(fallbackHeadline, 160) || "配信AI新聞");
 }
 const root = asRecord(parsed);
 if (!root) throw new Error("AI応答は受信しましたが、記事データがJSONオブジェクトではありません。");
 const article = asRecord(root.article) ?? asRecord(root.result) ?? root;
 const body = firstString(article, ["body", "articleText", "article", "content", "text", "正文"], 12000);
 let paragraphs = stringList(article.paragraphs ?? article.sections, 5, 1000);
 if (!paragraphs.length && body) paragraphs = splitBody(body);
 const summary = firstString(article, ["summary", "abstract", "lead", "description", "概要"], 500) || (paragraphs[0] ?? "").slice(0, 500);
 const headline = firstString(article, ["headline", "title", "heading", "見出し"], 160) || safeString(fallbackHeadline, 160) || "配信AI新聞";
 if (!paragraphs.length && summary) paragraphs = [summary];
 if (!paragraphs.length) throw new Error("AI応答は受信しましたが、headline／summary／paragraphs／bodyのいずれにも記事本文がありません。モデルの出力内容を確認してください。");
 return {
  headline, summary: summary || paragraphs[0].slice(0, 500), paragraphs,
  highlights: stringList(article.highlights ?? article.key_points, 5, 240),
  keywords: stringList(article.keywords ?? article.tags, 8, 40),
  videoSummary: firstString(article, ["videoSummary", "visualSummary"], 1000),
  videoScenes: stringList(article.videoScenes ?? article.scenes, 8, 300),
  audioSummary: firstString(article, ["audioSummary", "speechSummary"], 1200)
 };
}
