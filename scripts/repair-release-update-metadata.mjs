import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inspectReleaseManifest } from "./validate-update-assets.mjs";

const version = "0.3.3-alpha.66";
const directory = process.argv[2] || "repair";
const actualName = `Kick.Live.Message.Recorder.Setup.${version}.exe`;
const legacyRequestName = `Kick-Live-Message-Recorder-Setup-${version}.exe`;
const actualPath = join(directory, actualName);
assert.ok(existsSync(actualPath), "Published installer asset must be downloaded from GitHub Releases.");
const size = statSync(actualPath).size;
assert.ok(size > 10_000_000, "Refusing to repair manifests for an invalid small installer.");
const hash = createHash("sha512");
for await (const chunk of createReadStream(actualPath)) hash.update(chunk);
const sha512 = hash.digest("base64");

let firstManifest = "";
for (const channel of ["alpha", "beta", "latest"]) {
  const filePath = join(directory, channel + ".yml");
  const original = readFileSync(filePath, "utf8");
  assert.ok(original.includes("version: " + version), "Release manifest references a different version.");
  assert.ok(original.includes(actualName) || original.includes(legacyRequestName),
    "Unexpected update manifest filename; refusing an unsafe rewrite: " + channel);
  const updated = original.replaceAll(legacyRequestName, actualName);
  inspectReleaseManifest(updated, version, actualName, sha512, size);
  if (firstManifest) assert.equal(updated, firstManifest, "All updater channels must refer to identical binaries.");
  firstManifest = updated;
  writeFileSync(filePath, updated, "utf8");
}

// An alias is also uploaded for already-cached manifests still requesting
// the old dashed filename. It is byte-identical to the published installer.
copyFileSync(actualPath, join(directory, legacyRequestName));
const realBlockmap = join(directory, actualName + ".blockmap");
assert.ok(existsSync(realBlockmap), "Missing differential-update blockmap.");
copyFileSync(realBlockmap, join(directory, legacyRequestName + ".blockmap"));
console.log("Existing release repaired for alpha/beta/latest and cached old filename:", version);
