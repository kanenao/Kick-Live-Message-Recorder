import assert from "node:assert/strict";
import {
  describeEmptyAiResponse,
  extractAiResponseText,
  normalizeAiJsonText,
  parseAiArticleResponse
} from "../electron/ai-response.ts";

const articleJson = JSON.stringify({
  headline: "配信の見どころ",
  summary: "配信で確認できた内容をまとめました。",
  paragraphs: ["冒頭の内容です。", "後半の内容です。"],
  highlights: [],
  keywords: ["配信"],
  videoSummary: "",
  videoScenes: [],
  audioSummary: ""
});

// A blank convenience field must not hide text stored in Responses.output.
assert.equal(
  extractAiResponseText({
    output_text: "   ",
    output: [{
      type: "message",
      content: [{ type: "output_text", text: articleJson }]
    }]
  }),
  articleJson,
  "Responses output array must be used when output_text is empty"
);

// Responses API's common direct text field.
assert.equal(extractAiResponseText({ output_text: articleJson }), articleJson);

// Ollama /api/chat response.
assert.equal(
  extractAiResponseText({ message: { content: articleJson, done: true, done_reason: "stop" } }),
  articleJson
);

// OpenAI Chat Completions response shape.
assert.equal(
  extractAiResponseText({ choices: [{ message: { role: "assistant", content: articleJson } }] }),
  articleJson
);

// Text content may be split into multiple typed parts.
assert.equal(
  extractAiResponseText({
    output: [{
      type: "message",
      content: [
        { type: "output_text", text: "{\"headline\":\"test\"," },
        { type: "output_text", text: "\"summary\":\"ok\"}" }
      ]
    }]
  }),
  "{\"headline\":\"test\",\n\"summary\":\"ok\"}"
);

// Refusals are diagnostics, not article text.
const refusalPayload = {
  status: "completed",
  output: [{ type: "message", content: [{ type: "refusal", refusal: "not allowed" }] }]
};
assert.equal(extractAiResponseText(refusalPayload), "");
assert.match(describeEmptyAiResponse(refusalPayload), /拒否/);

// Incomplete Responses provide a useful reason instead of a generic empty-body error.
assert.match(
  describeEmptyAiResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
  /status=incomplete.*reason=max_output_tokens/
);

// Ollama's empty content includes completion diagnostics.
assert.match(
  describeEmptyAiResponse({ message: { content: "", done_reason: "length", eval_count: 4096 } }),
  /done_reason=length/
);

// Markdown-wrapped JSON is normalized before JSON.parse.
assert.equal(
  normalizeAiJsonText("```json\n" + articleJson + "\n```"),
  articleJson
);

console.log("AI記事応答形式テスト成功（Responses／Chat Completions／Ollama／空応答診断／JSONフェンス）");


// Ollama /api/generate uses "response", not message.content.
assert.equal(extractAiResponseText({ response: articleJson, done: true }), articleJson);

// Proxies may wrap the actual provider payload under data/result.
assert.equal(
  extractAiResponseText({ data: { output: [{ type: "message", content: [{ type: "output_text", text: articleJson }] }] } }),
  articleJson
);

// Some Ollama-compatible servers represent message content as typed objects.
assert.equal(
  extractAiResponseText({ message: { content: { text: articleJson } } }),
  articleJson
);

// Gemini-compatible text candidates are also recognized by the shared adapter.
assert.equal(
  extractAiResponseText({ candidates: [{ content: { parts: [{ text: articleJson }] } }] }),
  articleJson
);

// Structured response variants accept title/body and build paragraphs only from returned text.
const aliased = parseAiArticleResponse({
  response: JSON.stringify({ title: "返却タイトル", body: "最初の段落です。\n\n次の段落です。" })
}, "元配信タイトル");
assert.equal(aliased.headline, "返却タイトル");
assert.equal(aliased.paragraphs.length, 2);
assert.equal(aliased.summary, "最初の段落です。");

// Plain-text models no longer fail just because they did not follow the JSON schema.
const plainArticle = parseAiArticleResponse({
  message: { content: "見出し：配信の振り返り\n\n冒頭でゲームを開始しました。\n\n後半は視聴者と交流しました。" }
}, "元配信タイトル");
assert.equal(plainArticle.headline, "配信の振り返り");
assert.equal(plainArticle.paragraphs.length, 2);
assert.ok(plainArticle.summary.includes("冒頭"));

// Long unformatted prose is split into paragraphs instead of being silently cut at 1,000 chars.
const longPlainArticle = parseAiArticleResponse({
  response: "長文の段落です。" .repeat(140)
}, "元配信タイトル");
assert.ok(longPlainArticle.paragraphs.length > 1);
assert.ok(longPlainArticle.paragraphs.join("").length > 1000);

// Fenced JSON may include a short preamble or reasoning text.
const fence = String.fromCharCode(96).repeat(3);
const fenced = normalizeAiJsonText("結果はこちらです。\n" + fence + "json\n" + articleJson + "\n" + fence + "\n以上です。");
assert.equal(JSON.parse(fenced).headline, "配信の見どころ");

// Missing article body is still reported with the missing fields.
assert.throws(
  () => parseAiArticleResponse({ message: { content: JSON.stringify({ headline: "タイトルだけ" }) } }, "元タイトル"),
  /headline／summary／paragraphs／body/
);

// Truly empty payloads retain useful response diagnostics.
assert.match(
  describeEmptyAiResponse({ choices: [{ finish_reason: "length" }], usage: { output_tokens: 1800 } }),
  /finish_reason=length.*output_tokens=1800/
);
