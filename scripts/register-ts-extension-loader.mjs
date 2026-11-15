import { register } from "node:module";

// Enable the same extensionless relative imports used by the Electron TypeScript sources.
register("./resolve-ts-extension-loader.mjs", import.meta.url);
