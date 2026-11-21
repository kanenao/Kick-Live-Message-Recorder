import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const base64 = readFileSync(join(root, "assets/kick-app-icon.png.base64"), "utf8").trim();
const png = Buffer.from(base64, "base64");
const checksum = createHash("sha256").update(png).digest("hex");
if (checksum !== "c9002832acfc74bc0a4ed8985cfd6abe11344dba1567d24ff93059905cf0d946") {
  throw new Error("Kickの正式アイコンの画像が破損・差し替えされています。");
}
if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    png.readUInt32BE(16) !== 256 || png.readUInt32BE(20) !== 256) {
  throw new Error("Kickのアプリアイコンは256×256のPNGである必要があります。");
}

// Windows 10/11 supports PNG-compressed 256x256 frames in standard .ico.
// 0 in the directory's dimensions means 256. This keeps the generated icon
// pixel-identical across the installer, executable and app UI.
const header = Buffer.alloc(6 + 16);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = 0;  // 256px
header[7] = 0;
header[8] = 0;  // palette size: PNG determines colors
header[9] = 0;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(header.length, 18);

mkdirSync(join(root, "build"), { recursive: true });
mkdirSync(join(root, "public"), { recursive: true });
writeFileSync(join(root, "build/icon.ico"), Buffer.concat([header, png]));
writeFileSync(join(root, "build/icon.png"), png);
writeFileSync(join(root, "public/app-icon.png"), png);
console.log("Kick正式アイコン：Windows .ico / アプリ .png の生成とSHA-256検証が完了しました。");
