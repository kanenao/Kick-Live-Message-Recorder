import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

const match = packageJson.version.match(/^(\d+\.\d+\.\d+)-alpha\.(\d+)$/);
assert.ok(match, "package.json must use the alpha version format while alpha development is active");
const currentVersion = packageJson.version;
// β50は過去に公開済みの最終β版として残し、α版の公開後にこの値を更新する。
const latestPublicVersion = "0.1.0-beta.50";

assert.ok(readme.includes("開発中：" + currentVersion), "README must show the current alpha development version");
assert.ok(readme.includes("最新公開版：" + latestPublicVersion), "README must preserve the latest historically published beta version");
assert.ok(readme.includes("CHANGELOG.md"), "README must link to the version history");
assert.ok(readme.includes("バージョン番号の決め方"), "README must explain the independent core version and alpha counter");
assert.ok(readme.includes("alpha.N"), "README must document the continuing alpha sequence");
assert.ok(!readme.includes("0.1.0-beta.15"), "README must not retain the obsolete beta15 version");
assert.ok(changelog.includes("## " + currentVersion), "CHANGELOG must include the current alpha development version");
assert.ok(changelog.includes("## " + latestPublicVersion), "CHANGELOG must include the latest published version");

console.log("README／更新履歴のバージョン整合性テスト成功（開発中: " + currentVersion + "、公開済みβ: " + latestPublicVersion + "）");
