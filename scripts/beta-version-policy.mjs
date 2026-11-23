/**
 * Choose the next beta version from the latest public product version and
 * the actual scale of the beta changes. This does NOT update the product edition.
 * beta.N is a lifetime sequence and never resets on a base version bump.
 */
const betaPattern = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)-beta\\.(0|[1-9]\\d*)$/;
const stablePattern = /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$/;

function parseParts(input, pattern, kind) {
  if (typeof input !== "string") throw new Error(kind + " は文字列で指定してください");
  const match = pattern.exec(input);
  if (!match) throw new Error(kind + " のバージョン形式が不正です: " + input);
  const values = match.slice(1).map(Number);
  if (!values.every(Number.isSafeInteger)) throw new Error(kind + " の数値が大きすぎます");
  return values;
}

export function compareBaseVersions(a, b) {
  const aa = parseParts(a, stablePattern, "基本版");
  const bb = parseParts(b, stablePattern, "製品版");
  for (let i = 0; i < 3; i++) {
    if (aa[i] !== bb[i]) return Math.sign(aa[i] - bb[i]);
  }
  return 0;
}

export function nextBetaVersion(betaVersion, stableVersion, change = "sync") {
  const beta = parseParts(betaVersion, betaPattern, "β版");
  const stable = parseParts(stableVersion, stablePattern, "製品版");
  if (!["sync", "maintenance", "patch", "feature", "breaking"].includes(change)) {
    throw new Error("変更規模は sync / maintenance / patch / feature / breaking から選択してください");
  }
  let base = beta.slice(0, 3);
  // Never assign a beta base older than the latest actually released product.
  if (compareBaseVersions(base.join("."), stable.join(".")) < 0) base = stable.slice();
  if (change === "patch") {
    base = [base[0], base[1], base[2] + 1];
  } else if (change === "feature") {
    base = [base[0], base[1] + 1, 0];
  } else if (change === "breaking") {
    base = [base[0] + 1, 0, 0];
  }
  if (base.some(x => !Number.isSafeInteger(x)) || !Number.isSafeInteger(beta[3] + 1)) {
    throw new Error("β版の次のバージョン番号が数値上限を超えました");
  }
  return base.join(".") + "-beta." + (beta[3] + 1);
}
