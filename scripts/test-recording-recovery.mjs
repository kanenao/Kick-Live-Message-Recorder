import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { decideLiveRecordingRecovery, hasLiveRecordingStalled } from "../electron/recording-recovery.ts";
import { KickRecordingManager } from "../electron/recording.ts";

const mainSource = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
assert.doesNotMatch(mainSource, /if \(!live \|\| wasLive\) continue/,
  "LIVE polling must recover stopped recorders, not skip all continuing streams");
assert.match(mainSource, /const deliberatelyStopped = manuallyStoppedLiveBroadcasts\.has\(result\.slug\)/,
  "Explicit user stop must suppress automatic recording restart");
assert.match(mainSource, /if \(!wasLive && state\.settings\.notifyOnLive\)/,
  "LIVE start notifications must not repeat every polling interval");


const base = {
  probe: { isLive: true, startedAt: "2026-11-16T09:00:00Z" },
  expectedStreamStartedAt: "2026-11-16T09:00:00Z",
  code: 0, savedFileCount: 1, runtimeMs: 5 * 60_000,
  failuresUsed: 5, maxFailures: 5, fatalError: false, stalled: false, attemptProducedVideo: true
};
const check = extra => decideLiveRecordingRecovery({ ...base, ...extra });
assert.equal(check({}).action, "retry", "exit 0 must not end an ongoing LIVE");
assert.equal(check({}).nextFailures, 1, "healthy segments reset consecutive failure count");
assert.equal(check({ attemptProducedVideo: false, savedFileCount: 2 }).action, "error",
  "older saved segment must not hide failure to record the current reconnect attempt");
assert.equal(check({ probe: { isLive: false, startedAt: null } }).action, "complete");
assert.equal(check({ probe: { isLive: false, startedAt: null }, savedFileCount: 0 }).action, "error");
assert.equal(check({ probe: null, runtimeMs: 1000, failuresUsed: 5 }).action, "error");
assert.equal(check({ fatalError: true }).action, "error");
assert.equal(check({ stalled: true }).action, "retry");
assert.equal(check({ probe: { isLive: true, startedAt: "2026-11-16T10:00:00Z" } }).action, "complete",
  "Do not mix the next broadcast into a previous session");
assert.equal(hasLiveRecordingStalled(0, 179_999), false);
assert.equal(hasLiveRecordingStalled(0, 180_000), true);
assert.match(mainSource, /const confirmedOffline = !live && offlinePolls >= 3/,
  "single offline response must not remove the manual-stop lock");
assert.match(mainSource, /if \(!result\.found\) continue;/,
  "unknown API results must not be treated as offline");


const directory = mkdtempSync(join(tmpdir(), "kick-live-recovery-"));
const events = [];
const processes = [];
const expectedStreamStartedAt = "2026-11-16T09:00:00Z";
const fakeSpawn = (_binary, args) => {
  const process = new EventEmitter();
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.outputPath = args[args.indexOf("--output") + 1].replace("%(ext)s", "mp4");
  process.kill = () => { queueMicrotask(() => process.emit("close", null, "SIGINT")); return true; };
  processes.push(process);
  return process;
};
try {
  const manager = new KickRecordingManager(
    event => events.push(event),
    async () => ({ isLive: true, startedAt: expectedStreamStartedAt }),
    fakeSpawn
  );
  manager.start("sample", directory, { retryCount: 5, retryDelaySeconds: 5, streamStartedAt: expectedStreamStartedAt });
  assert.equal(processes.length, 1);
  processes[0].emit("spawn");
  writeFileSync(processes[0].outputPath, "saved video bytes");
  processes[0].emit("close", 0, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.isRecording("sample"), true, "premature clean exit keeps recording session active");
  assert.ok(events.some(event => event.status === "starting" && event.message.includes("再接続")),
    "user receives a reconnect status");
  assert.equal(events.some(event => event.status === "stopped"), false,
    "do not claim broadcast completion while it is live");

  manager.stop("sample");
  assert.equal(manager.isRecording("sample"), false);
  assert.equal(events.at(-1).status, "stopped");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(processes.length, 1, "intentional stop cancels queued reconnect");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log("LIVE録画の途中終了・継続確認・再接続・手動停止・無進捗判定テスト成功");
