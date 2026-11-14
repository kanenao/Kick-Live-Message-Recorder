import assert from "node:assert/strict";
import {
  describeEmptyAiResponse,
  extractAiResponseText,
  normalizeAiJsonText
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
