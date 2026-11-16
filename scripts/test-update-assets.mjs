import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReleaseArtifacts } from "./validate-update-assets.mjs";

const version = "0.3.3-alpha.66";
const expectedName = `Kick-Live-Message-Recorder-Setup-${version}.exe`;
const wrongName = `Kick.Live.Message.Recorder.Setup.${version}.exe`;
const temp = mkdtempSync(join(tmpdir(), "kick-release-manifest-"));
const bytes = Buffer.from("Sample installer fixture to test manifest checking.");
const sha512 = createHash("sha512").update(bytes).digest("base64");

function manifest(fileName = expectedName, hash = sha512) {
  return `version: ${version}
files:
  - url: ${fileName}
    sha512: ${hash}
    size: ${bytes.length}
path: ${fileName}
sha512: ${hash}
releaseDate: '2026-11-17T00:00:00.000Z'
`;
}
function writeChannels(content) {
  for (const channel of ["alpha", "beta", "latest"]) writeFileSync(join(temp, channel + ".yml"), content);
}

try {
  writeFileSync(join(temp, expectedName), bytes);
  writeChannels(manifest());
  const valid = await validateReleaseArtifacts(temp, version);
  assert.equal(valid.installer, expectedName, "Matching installer URL and asset filename should pass");

  writeChannels(manifest(wrongName));
  await assert.rejects(() => validateReleaseArtifacts(temp, version), /URL must match/,
    "A manifest pointing at a differently normalized asset name must fail CI");

  writeChannels(manifest(expectedName, "not-the-sha512"));
  await assert.rejects(() => validateReleaseArtifacts(temp, version), /SHA512/,
    "Wrong installer hash must stop publication");

  writeChannels(manifest());
  writeFileSync(join(temp, "beta.yml"), manifest().replace("version: " + version, "version: 9.9.9-alpha.999"));
  await assert.rejects(() => validateReleaseArtifacts(temp, version), /version must match/,
    "A mismatched legacy channel must stop publication");

  console.log("自動更新404再発防止：実ファイル名・マニフェストURL・SHA512・各チャンネルの回帰テスト成功");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
