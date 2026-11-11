import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Electron本番版は file:// で開くため、アセットURLを相対パスにする。
  base: "./",
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true }
});