import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";

/**
 * Vite config:
 * - alias для удобных импортов
 * - proxy для `/api` на backend с логированием
 *
 * ВАЖНО: Для Docker Desktop на Windows используем host.docker.internal
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  const configuredApiUrl = env.VITE_API_URL || "http://127.0.0.1:8001";
  const isDocker = fs.existsSync("/.dockerenv");
  const pointsToContainerLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?/i.test(
    configuredApiUrl
  );

  // Vite proxy runs inside the frontend container, so localhost is not the backend there.
  const apiUrl = isDocker && pointsToContainerLocalhost ? "http://web:8000" : configuredApiUrl;

  console.log(`🔧 Vite Proxy: /api → ${apiUrl}`);

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      port: 5173,
      host: '0.0.0.0',  // Слушать на всех интерфейсах для Docker
      proxy: {
        "/api": {
          target: apiUrl,
          changeOrigin: true,
          secure: false,
          configure: (proxy, _options) => {
            // Логирование ошибок proxy
            proxy.on('error', (err, _req, _res) => {
              console.log('❌ PROXY ERROR:', err.message);
            });
            // Логирование запросов
            proxy.on('proxyReq', (proxyReq, req, _res) => {
              console.log(`📤 PROXY → Backend: ${req.method} ${req.url} → ${proxyReq.path}`);
            });
            // Логирование ответов
            proxy.on('proxyRes', (proxyRes, req, _res) => {
              console.log(`📥 Proxy ← Backend: ${req.method} ${req.url} → Status ${proxyRes.statusCode}`);
            });
          },
        },
        '/media': {
          target: apiUrl,
          changeOrigin: true,
          secure: false,
          configure: (proxy, _options) => {
            proxy.on('error', (err, _req, _res) => {
              console.log('❌ PROXY ERROR:', err.message);
            });
            proxy.on('proxyReq', (proxyReq, req, _res) => {
              console.log(`📤 PROXY → Backend: ${req.method} ${req.url} → ${proxyReq.path}`);
            });
            proxy.on('proxyRes', (proxyRes, req, _res) => {
              console.log(`📥 Proxy ← Backend: ${req.method} ${req.url} → Status ${proxyRes.statusCode}`);
            });
          },
        },
      },
    },
    build: {
      outDir: "dist",
    },
  };
});
