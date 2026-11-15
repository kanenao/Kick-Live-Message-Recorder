import assert from "node:assert/strict";
import { parseReleaseNotes, splitReleaseNoteInline } from "../src/shared/release-notes.ts";

const html = [
  "<h1>Kick Live Message Recorder 0.2.5-alpha.60</h1>",
  "<p><strong>α版（開発・先行テスト向け）</strong>の初回公開です。</p>",
  "<h2>主な改善点</h2>",
  "<ul>",
  "<li><strong>録画ライブラリ</strong>：配信者別に表示。</li>",
  "<li>配信AI新聞：16:9の放送画面を表示。</li>",
  "</ul>",
  "<h2>配布</h2>",
  "<p>更新情報用 <code>latest.yml</code> を同梱します。</p>"
].join("\n");

const parsed = parseReleaseNotes(html);
assert.deepEqual(parsed.map(block => block.kind), [
  "heading", "paragraph", "heading", "list", "heading", "paragraph"
]);
assert.equal(parsed[0].kind === "heading" && parsed[0].text, "Kick Live Message Recorder 0.2.5-alpha.60");
assert.deepEqual(parsed[3], {
  kind: "list",
  items: ["**録画ライブラリ**：配信者別に表示。", "配信AI新聞：16:9の放送画面を表示。"]
});
assert.deepEqual(splitReleaseNoteInline("**重要**：`latest.yml`"), [
  { kind: "strong", value: "重要" },
  { kind: "text", value: "：" },
  { kind: "code", value: "latest.yml" }
]);
assert.deepEqual(parseReleaseNotes("## 修正点\n\n- コメント修正\n- 録画修正").map(block => block.kind), [
  "heading", "list"
]);
assert.equal(parseReleaseNotes("<p>日本語 &amp; English &#x2714; &#12354;</p>")[0].text, "日本語 & English ✔ あ");
const hostile = parseReleaseNotes('<script>alert("XSS")</script><h2 onclick="alert(1)">更新</h2><p>安全<img src=x onerror=alert(1)>表示</p>');
assert.deepEqual(hostile, [
  { kind: "heading", level: 2, text: "更新" },
  { kind: "paragraph", text: "安全表示" }
]);
assert.deepEqual(parseReleaseNotes(""), []);
console.log("リリースノートHTML・Markdown・文字実体参照・安全性テスト成功");
