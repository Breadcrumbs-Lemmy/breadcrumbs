import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Local HTTPS is opt-in because the normal developer loop does not need TLS.
 * When enabled, mkcert files in this package provide a browser-trusted
 * certificate for `https://localhost:5173`; the `/api` proxy keeps the browser
 * on the same origin while the Fastify API remains on its local HTTP port.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const useHttps = (process.env.BREADCRUMBZ_DEV_HTTPS ?? env.BREADCRUMBZ_DEV_HTTPS) === "true";
  const port = Number(process.env.PORT ?? env.PORT) || 5173;

  let https: { key: Buffer; cert: Buffer } | undefined;
  if (useHttps) {
    const keyPath = resolve(
      process.cwd(),
      process.env.BREADCRUMBZ_DEV_TLS_KEY ?? env.BREADCRUMBZ_DEV_TLS_KEY ?? "localhost-key.pem",
    );
    const certPath = resolve(
      process.cwd(),
      process.env.BREADCRUMBZ_DEV_TLS_CERT ?? env.BREADCRUMBZ_DEV_TLS_CERT ?? "localhost.pem",
    );
    if (!existsSync(keyPath) || !existsSync(certPath)) {
      throw new Error(
        `Local HTTPS is enabled but its certificate is missing. Generate ${keyPath} and ${certPath} with mkcert first.`,
      );
    }
    https = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  }

  return {
    plugins: [react()],
    server: {
      port,
      https,
      // HTTPS dev mode uses this proxy so browser requests stay HTTPS and
      // same-origin; HTTP dev mode continues using the direct API fallback.
      proxy: {
        "/api": {
          target: "http://127.0.0.1:8787",
          changeOrigin: false,
        },
      },
    },
  };
});
