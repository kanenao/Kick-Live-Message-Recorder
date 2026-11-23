import type { KickEditionHistory, KickEditionRelease } from "./edition-releases";

/** Never let an ordinary beta update discover or download a stable installer. */
export const isBetaVersion = (version: unknown): version is string =>
  typeof version === "string" && /^\d+\.\d+\.\d+-beta\.\d+$/.test(version);

function parts(version: string): number[] {
  if (!isBetaVersion(version)) throw new Error("β版以外のバージョンを更新先にできません。");
  return version.match(/\d+/g)!.map(Number);
}

export function chooseBetaUpdate(history: KickEditionHistory, currentVersion: string): KickEditionRelease | null {
  const current = parts(currentVersion);
  const available = history.beta.filter(release => {
    if (release.edition !== "beta" || !isBetaVersion(release.version)) return false;
    return parts(release.version).some((part, index) => {
      for (let i = 0; i < index; i++) if (parts(release.version)[i] !== current[i]) return false;
      return part > current[index];
    });
  });
  available.sort((a, b) => {
    const pa = parts(a.version), pb = parts(b.version);
    for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
    return 0;
  });
  return available[0] ?? null;
}

/** Pin to a validated beta release directory, bypassing GitHub's latest stable lookup. */
export function betaUpdateFeed(release: KickEditionRelease): string {
  if (release.edition !== "beta" || !isBetaVersion(release.version)) {
    throw new Error("製品版の更新先はβ版では利用できません。");
  }
  const root = "https://github.com/kanenao/Kick-Live-Message-Recorder/releases/download/";
  const tag = "v" + release.version;
  const expected = root + tag + "/Kick-Live-Message-Recorder-Setup-" + release.version + ".exe";
  if (release.installerUrl !== expected) throw new Error("インストーラーの取得先が正規のβ版ではありません。");
  return root + tag + "/";
}
