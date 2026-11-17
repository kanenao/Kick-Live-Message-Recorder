import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");

const videoButton = /<button className=\{tab === "comment-video"[^\n]*>✦ <span>コメント付き動画<\/span><\/button>/;
const articleButton = /<button className=\{tab === "articles"[^\n]*>▤ <span>配信記事<\/span><\/button>/;

assert.match(app, videoButton, "コメント付き動画のメニューを維持すること");
assert.match(app, articleButton, "配信記事のメニューを維持すること");

// JSXボタンの間に\\nという通常文字が混入すると、画面にもそのまま出てしまう。
const start = app.search(videoButton) + app.match(videoButton)[0].length;
const end = app.search(articleButton);
assert.match(app.slice(start, end), /^\s*$/, "メニュー間に余計なテキストを描画しないこと");
assert.ok(!css.split(/\r?\n/).some(line => line.trim() === String.raw`\n`), "CSSの不要な改行文字列を除去すること");

console.log("配信記事メニューの不要文字（\\n）回帰テスト成功");
