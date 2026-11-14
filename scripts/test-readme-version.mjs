import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

const match = packageJson.version.match(/^(\\d+\\.\\d+\\.\\d+)-beta\\.(\\d+)$/);
assert.ok(match, "package.json must use the beta version format while beta-only development is active");
const currentVersion = packageJson.version;
const previousPublicVersion = match[1] + "-beta." + (Number(match[2]) - 1);

assert.ok(readme.includes("開発中：" + currentVersion), "README must show the current development version");
assert.ok(readme.includes("最新公開版：" + previousPublicVersion), "README must show the previous public beta version");
assert.ok(readme.includes("CHANGELOG.md"), "README must link to the version history");
assert.ok(!readme.includes("0.1.0-beta.15"), "README must not retain the obsolete beta15 version");
assert.ok(changelog.includes("## " + currentVersion), "CHANGELOG must include the current development version");
assert.ok(changelog.includes("## " + previousPublicVersion), "CHANGELOG must include the latest public version");

console.log("README／更新履歴のバージョン整合性テスト成功（開発中: " + currentVersion + "、公開版: " + previousPublicVersion + "）");
