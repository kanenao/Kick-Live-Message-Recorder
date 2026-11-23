/**
 * Local, per-Windows-user history of actually launching a packaged beta build.
 * This is a UI eligibility marker, NOT a licence, cryptographic identity,
 * authentication, or protection against manual modification by the PC owner.
 * Never store personal information or credentials here.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const markerName = "beta-access.json";
const betaVersion = /^\\d+\\.\\d+\\.\\d+-beta\\.\\d+$/;
const markerMaxBytes = 1024;

export type BetaHistory = {
  eligible: boolean;
  version?: string;
  activatedAt?: string;
};

export function betaHistoryPath(appDataDirectory: string): string {
  return join(appDataDirectory, "kanenao", "Kick Live Message Recorder", markerName);
}

export function readBetaHistory(appDataDirectory: string): BetaHistory {
  try {
    const file = betaHistoryPath(appDataDirectory);
    if (!existsSync(file)) return { eligible: false };
    const stats = lstatSync(file);
    if (!stats.isFile() || stats.size > markerMaxBytes) return { eligible: false };
    const data: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!data || typeof data !== "object") return { eligible: false };
    const marker = data as Record<string, unknown>;
    if (marker.schema !== 1 || marker.edition !== "beta" ||
        typeof marker.version !== "string" || !betaVersion.test(marker.version) ||
        typeof marker.activatedAt !== "string" || Number.isNaN(Date.parse(marker.activatedAt))) {
      return { eligible: false };
    }
    return { eligible: true, version: marker.version, activatedAt: marker.activatedAt };
  } catch {
    return { eligible: false };
  }
}

export function registerBetaHistory(
  appDataDirectory: string, version: string,
  options: { packaged: boolean; platform: string }
): boolean {
  if (!options.packaged || options.platform !== "win32" || !betaVersion.test(version)) return false;
  if (readBetaHistory(appDataDirectory).eligible) return true;
  const file = betaHistoryPath(appDataDirectory);
  const temp = file + "." + process.pid + ".tmp";
  try {
    mkdirSync(join(appDataDirectory, "kanenao", "Kick Live Message Recorder"), { recursive: true });
    writeFileSync(temp, JSON.stringify({
      schema: 1, edition: "beta", version, activatedAt: new Date().toISOString()
    }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temp, file);
    return true;
  } catch {
    try { unlinkSync(temp); } catch { /* never fail app startup */ }
    return false;
  }
}
