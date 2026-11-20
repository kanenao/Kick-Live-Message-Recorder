import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildTimedCommentSchedule, visibleTimedComments
} from "../src/ui/comment-live-preview.ts";

const settings = {
  fontSize: 48, fontFamily: "ＭＳ Ｐゴシック", durationSeconds: 6,
  speedPercent: 100, rowLimit: 4, collisionGap: 24, opacity: 95,
  position: "scroll", autoFlow: false, showUsername: false
};
const comments = [
  { seconds: 3, content: "うぽつ", username: "viewerA", color: "#ffffff" },
  { seconds: 4, content: "8888888", username: "viewerB", color: "#aabbcc" },
  { seconds: 20, content: "コメントに動画の時刻を合わせる", username: "viewerC" }
];
const timed = buildTimedCommentSchedule(comments, 1280, 720, settings);
assert.equal(timed.length, 3);
assert.equal(timed[0].startSeconds, 3);
assert.equal(timed[0].position, "scroll");
assert.equal(timed[1].color, "#aabbcc");
assert.equal(visibleTimedComments(timed, 0, 1280).length, 0);
assert.equal(visibleTimedComments(timed, 3, 1280).length, 1);
assert.equal(visibleTimedComments(timed, 20, 1280).some(x => x.text.includes("コメント")), true,
  "Seeking to 20s displays the comment at that video time");
assert.deepEqual(visibleTimedComments(timed, Number.NaN, 1280), []);
assert.deepEqual(visibleTimedComments(timed, -1, 1280), []);
const now = visibleTimedComments(timed, 3, 1280)[0].x;
const later = visibleTimedComments(timed, 4, 1280)[0].x;
assert.ok(now > later, "Comment moves right-to-left as actual video time advances");
const faster = buildTimedCommentSchedule(comments, 1280, 720, { ...settings, speedPercent: 200 });
assert.ok(faster[0].endSeconds < timed[0].endSeconds, "Changing speed changes preview immediately");
const bigger = buildTimedCommentSchedule(comments, 1280, 720, { ...settings, fontSize: 72 });
assert.ok(bigger[0].fontSize > timed[0].fontSize, "Changing font size changes video overlay");
const showUser = buildTimedCommentSchedule(comments, 1280, 720, { ...settings, showUsername: true });
assert.ok(showUser[0].text.startsWith("viewerA : "), "Show usernames option updates preview");

const command = buildTimedCommentSchedule([
  { seconds: 1, content: "上固定", position: "top" },
  { seconds: 1.2, content: "下固定", position: "bottom" },
  { seconds: 1.4, content: "中央スクロール", position: "scroll" }
], 1280, 720, { ...settings, position: "command" });
assert.deepEqual(command.map(c => c.position), ["top", "bottom", "scroll"]);
assert.ok(command[0].y < command[1].y, "Top comments sit above bottom comments");

const overlap = buildTimedCommentSchedule(Array.from({ length: 5 },
  (_, i) => ({ seconds: 1, content: "A long comment number " + i })),
1280, 720, { ...settings, rowLimit: 1 });
assert.ok(overlap[1].startSeconds > overlap[0].startSeconds,
  "Comments entering the same lane do not overwrite each other");
assert.equal(buildTimedCommentSchedule([
  { seconds: -3, content: "invalid" }, { seconds: 1, content: "" }
], 1280, 720, settings).length, 0);
assert.equal(buildTimedCommentSchedule(Array.from({ length: 1900 },
  (_, i) => ({ seconds: i, content: "test" })), 1280, 720, settings).length, 1500,
  "Renderer work is bounded even with huge logs");

const app = readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8");
const component = readFileSync(new URL("../src/ui/CommentVideoLivePreview.tsx", import.meta.url), "utf8");
const backend = readFileSync(new URL("../electron/comment-video.ts", import.meta.url), "utf8");
const style = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");
const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
assert.match(component, /<video ref=\{videoRef\}/, "Nico-style source video playback exists");
assert.match(component, /<canvas ref=\{canvasRef\}/, "Time-locked canvas overlay exists");
assert.match(component, /video\.currentTime/, "Canvas is synchronized with the actual playback clock");
assert.match(component, /requestAnimationFrame/, "Canvas redraws while video plays");
assert.match(component, /URL\.revokeObjectURL/, "Selected video file URLs are released");
assert.match(component, /selected\.name\.toLowerCase\(\) !== fileName\.toLowerCase\(\)/,
  "Preview video must match the selected recording basename");
assert.match(app, /<CommentVideoLivePreview selectedVideoPath=\{selectedCommentVideoPath\}/,
  "Kick composer integrates the live preview");
assert.match(app, /position: commentVideoPosition/, "Command position choices propagate to backend");
assert.match(preload, /previewCommentVideo:[^\n]+position\?:/, "Typed desktop IPC supports command positions");
assert.match(backend, /const sampleSize = Math\.min\(1200, previewCandidates\.length\)/,
  "Entire broadcast supplies enough timeline samples for playback");
assert.match(style, /\.comment-video-live-stage video/, "Video preview stage has responsive styles");
console.log("Kick/Nicoコメント合成：動画時刻との同期・シーク・速度・サイズ・位置・重なり・回帰検証成功");
