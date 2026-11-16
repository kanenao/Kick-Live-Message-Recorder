import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function inspectReleaseManifest(manifest, version, expectedFileName, expectedHash, expectedSize) {
  const versionMatch = manifest.match(/^version:\s*(\S+)\s*$/m);
  assert.equal(versionMatch?.[1], version, "Update manifest version must match package.json");
  const urlMatch = manifest.match(/^\s*-\s*url:\s*(.+?)\s*$/m);
  assert.ok(urlMatch, "Update manifest must include a files[].url");
  const url = decodeURIComponent(urlMatch[1].trim().replace(/^["']|["']$/g, ""));
  assert.equal(url, expectedFileName, "Update manifest URL must match the release asset filename exactly");
  const pathMatch = manifest.match(/^path:\s*(.+?)\s*$/m);
  if (pathMatch) {
    assert.equal(decodeURIComponent(pathMatch[1].trim().replace(/^["']|["']$/g, "")), expectedFileName,
      "Legacy update path must match the real installer filename");
  }
  const hashes = [...manifest.matchAll(/^\s*sha512:\s*(\S+)\s*$/gm)];
  assert.ok(hashes.length >= 1, "Update manifest must include sha512 integrity data");
  for (const hash of hashes) assert.equal(hash[1], expectedHash, "SHA512 must match the published executable");
  const sizeMatch = manifest.match(/^\s*size:\s*(\d+)\s*$/m);
  if (sizeMatch) assert.equal(Number(sizeMatch[1]), expectedSize, "Manifest size must match the installer");
  return url;
}

export async function validateReleaseArtifacts(directory, version) {
  const files = readdirSync(directory);
  const installers = files.filter(file => file.toLowerCase().endsWith(".exe"));
  assert.equal(installers.length, 1, "Exactly one .exe installer is expected in a release candidate");
  const expectedFileName = `Kick-Live-Message-Recorder-Setup-${version}.exe`;
  assert.equal(installers[0], expectedFileName, "Only the deterministic ASCII installer filename is permitted");
  const target = join(directory, installers[0]);
  const expectedSize = statSync(target).size;
  assert.ok(expectedSize > 0, "Installer must not be empty");
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  const sha512 = hash.digest("base64");
  const manifests = ["alpha.yml", "beta.yml", "latest.yml"];
  const contents = manifests.map(file => {
    const path = join(directory, file);
    assert.ok(existsSync(path), "Missing updater manifest: " + file);
    return readFileSync(path, "utf8");
  });
  for (const contentsForChannel of contents) {
    inspectReleaseManifest(contentsForChannel, version, expectedFileName, sha512, expectedSize);
  }
  assert.equal(contents[0], contents[1], "beta.yml must be identical to alpha.yml");
  assert.equal(contents[0], contents[2], "latest.yml must be identical to alpha.yml");
  return { installer: expectedFileName, bytes: expectedSize, version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] || "release";
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  await validateReleaseArtifacts(directory, version);
  console.log("更新用ファイル名・SHA512・サイズ・3チャンネル一致チェック成功：" + version);
}
