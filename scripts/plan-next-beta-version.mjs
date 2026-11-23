import { readFileSync } from "node:fs";
import { nextBetaVersion } from "./beta-version-policy.mjs";

const [stable, change = "maintenance"] = process.argv.slice(2);
if (!stable) {
  console.error("使い方: node scripts/plan-next-beta-version.mjs <公開済み製品版X.Y.Z> [sync|maintenance|patch|feature|breaking]");
  console.error("公開済み製品版の番号はGitHub Releasesで先に確認してください。");
  process.exitCode = 1;
} else {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  try {
    console.log("現在のβ版: " + version);
    console.log("公開済み製品版: " + stable);
    console.log("開発規模: " + change);
    console.log("次のβ版候補: " + nextBetaVersion(version, stable, change));
    console.log("このコマンドは提案のみ。package.json/UI/README/CHANGELOGは検証後に同時更新します。");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
