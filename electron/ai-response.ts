type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function readContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const chunks: string[] = [];
  for (const part of value) {
    const record = asRecord(part);
    if (!record) continue;
    if (typeof record.text === "string") {
      chunks.push(record.text);
    } else if (typeof record.refusal === "string") {
      chunks.push(record.refusal);
    }
  }
  return chunks.join("\n");
}

/**
 * Extract article text from Responses API, Chat Completions and Ollama chat
 * payloads. Empty convenience fields must not hide a populated output array.
 */
export function extractAiResponseText(payload: UnknownRecord): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const chunks: string[] = [];
  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      const record = asRecord(item);
      if (!record) continue;
      const content = readContentText(record.content);
      if (content.trim()) chunks.push(content);
      else if (typeof record.text === "string" && record.text.trim()) chunks.push(record.text);
    }
  }

  const message = asRecord(payload.message);
  if (message) {
    const content = readContentText(message.content);
    if (content.trim()) chunks.push(content);
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    const choiceRecord = asRecord(choice);
    if (!choiceRecord) continue;
    const choiceMessage = asRecord(choiceRecord.message) ?? asRecord(choiceRecord.delta);
    if (choiceMessage) {
      const content = readContentText(choiceMessage.content);
      if (content.trim()) chunks.push(content);
    }
    if (typeof choiceRecord.text === "string" && choiceRecord.text.trim()) {
      chunks.push(choiceRecord.text);
    }
  }

  if (typeof payload.content === "string" && payload.content.trim()) {
    chunks.push(payload.content);
  }
  return chunks.join("\n").trim();
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
  const refusal = Array.isArray(payload.output) && payload.output.some(item => {
    const record = asRecord(item);
    if (!record || !Array.isArray(record.content)) return false;
    return record.content.some(part => {
      const partRecord = asRecord(part);
      return Boolean(partRecord && (partRecord.type === "refusal" || typeof partRecord.refusal === "string"));
    });
  });

  if (refusal) {
    return "AIモデルが記事生成を拒否したため、記事本文を取得できませんでした。AIモデルの設定と送信内容を確認してください。";
  }

  const diagnostics = [
    status ? "status=" + status : "",
    reason ? "reason=" + reason : "",
    doneReason ? "done_reason=" + doneReason : "",
    errorCode ? "error=" + errorCode : "",
    errorMessage ? errorMessage.slice(0, 180) : ""
  ].filter(Boolean);

  if (diagnostics.length > 0) {
    return "AI応答に記事本文が含まれていません（" + diagnostics.join(" / ") + "）。モデルの応答状態・出力上限・設定を確認してください。";
  }
  return "AI応答に記事本文が含まれていません。AIモデルが空の応答を返した可能性があります。モデル名・Ollamaの状態・AIサービスの応答を確認してください。";
}

/**
 * Remove common Markdown code fences without changing the JSON payload.
 */
export function normalizeAiJsonText(input: string): string {
  const trimmed = input.trim();
  const fenced = trimmed.match(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i);
  if (fenced) return fenced[1].trim();
  return trimmed;
}
