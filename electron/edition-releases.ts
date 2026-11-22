/**
 * Github Releases is the source of truth for edition history and manual edition changes.
 * Do not infer a product release from stable branch/package.json or any pre-release.
 * This module constructs URLs itself; the renderer never provides external URLs.
 */
export type KickEdition = "beta" | "stable";

export type KickEditionRelease = {
  edition: KickEdition;
  version: string;
  title: string;
  publishedAt: string;
  notes: string;
  url: string;
  installerUrl: string;
};

export type KickEditionHistory = {
  beta: KickEditionRelease[];
  stable: KickEditionRelease[];
};

const REPOSITORY = "kanenao/Kick-Live-Message-Recorder";
const API = "https://api.github.com/repos/" + REPOSITORY + "/releases?per_page=100";
const RELEASE_ROOT = "https://github.com/" + REPOSITORY + "/releases";
const betaVersion = /^\\d+\\.\\d+\\.\\d+-beta\\.\\d+$/;
const stableVersion = /^\\d+\\.\\d+\\.\\d+$/;

type RawAsset = { name?: unknown; browser_download_url?: unknown; size?: unknown };
type RawRelease = {
  tag_name?: unknown; draft?: unknown; prerelease?: unknown;
  published_at?: unknown; name?: unknown; body?: unknown; assets?: unknown;
};

export function parseEditionReleases(input: unknown): KickEditionHistory {
  const result: KickEditionHistory = { beta: [], stable: [] };
  if (!Array.isArray(input)) throw new Error("GitHub Releasesの応答が不正です。");
  for (const raw of input.slice(0, 100) as RawRelease[]) {
    if (!raw || typeof raw !== "object" || raw.draft === true) continue;
    const tag = raw.tag_name;
    if (typeof tag !== "string" || !tag.startsWith("v")) continue;
    const version = tag.slice(1);
    const edition: KickEdition | null = betaVersion.test(version) && raw.prerelease === true
      ? "beta"
      : stableVersion.test(version) && raw.prerelease === false ? "stable" : null;
    if (!edition) continue;
    const installer = "Kick-Live-Message-Recorder-Setup-" + version + ".exe";
    const manifest = edition === "beta" ? "beta.yml" : "latest.yml";
    const assets = Array.isArray(raw.assets) ? raw.assets as RawAsset[] : [];
    // A release without a Windows installer and its own channel manifest is NOT installable.
    const exe = assets.find(asset => asset?.name === installer &&
      typeof asset.size === "number" && asset.size > 100000);
    if (!exe || !assets.some(asset => asset?.name === manifest)) continue;
    const validInstallerUrl = RELEASE_ROOT + "/download/" + tag + "/" + installer;
    if (exe.browser_download_url !== validInstallerUrl) continue;
    result[edition].push({
      edition, version, title: typeof raw.name === "string" ? raw.name.slice(0, 200) : version,
      publishedAt: typeof raw.published_at === "string" ? raw.published_at : "",
      notes: typeof raw.body === "string" ? raw.body.slice(0, 3000) : "",
      url: RELEASE_ROOT + "/tag/" + tag, installerUrl: validInstallerUrl
    });
  }
  for (const edition of ["beta", "stable"] as const) {
    result[edition].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    result[edition] = result[edition].slice(0, 20);
  }
  return result;
}

export async function fetchEditionReleases(): Promise<KickEditionHistory> {
  const response = await fetch(API, {
    method: "GET",
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "Kick-Live-Message-Recorder",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) {
    throw new Error("GitHub Releasesを取得できません（HTTP " + response.status + "）。");
  }
  return parseEditionReleases(await response.json());
}
