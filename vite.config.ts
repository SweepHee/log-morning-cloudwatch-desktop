import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    strictPort: true,
    host: "127.0.0.1",
    port: 1420,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // Tauri 2가 사용하는 최신 WebView2/WKWebView 기준. 구형 브라우저 호환 변환은
    // 데스크톱 앱에 필요 없고 최신 Vite 번들러와도 이 설정이 가장 안정적이다.
    target: "es2022",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
