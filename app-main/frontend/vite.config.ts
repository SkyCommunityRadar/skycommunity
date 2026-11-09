import path from "node:path";
import { defineConfig, type Plugin, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// DISABLE_HOT_RELOAD=true turns file watching off (e.g. on a server).
const hotReloadDisabled = process.env.DISABLE_HOT_RELOAD === "true";

// Content-Security-Policy of the published site: the browser only runs the site's own scripts and only talks to
// the site itself, the map tiles and Discord avatars. Injected at build time only (the dev server needs inline
// scripts for hot reload). The host should ALSO send it as an HTTP header (see docs/DEPLOIEMENT.md).
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://cdn.discordapp.com https://tiles.openfreemap.org https://server.arcgisonline.com",
  "connect-src 'self' https://tiles.openfreemap.org",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-src 'none'",
].join("; ");
const cspPlugin = (): Plugin => ({
  name: "skyradar-csp",
  apply: "build",
  transformIndexHtml: (html) => html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

// https://vite.dev/config/
export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), cspPlugin()],
    resolve: {
      alias: [
        { find: "@", replacement: path.resolve(__dirname, "./src") },
        // lucide 1.x dropped brand logos; src/lib/lucide-react.tsx restores them on top of the real package.
        { find: /^lucide-react$/, replacement: path.resolve(__dirname, "./src/lib/lucide-react.tsx") },
        { find: "lucide-react-upstream", replacement: path.resolve(__dirname, "./node_modules/lucide-react") },
        // recharts 3's Tooltip callback types reject the annotations agents write; src/lib/recharts.tsx adapts them.
        { find: /^recharts$/, replacement: path.resolve(__dirname, "./src/lib/recharts.tsx") },
        { find: "recharts-upstream", replacement: path.resolve(__dirname, "./node_modules/recharts") },
      ],
    },
    // Every shipped dep, pre-bundled up front. Vite discovers deps lazily, so the first
    // import outside the initial graph would trigger a re-optimize + reload mid-session.
    optimizeDeps: {
      include: [
        "@base-ui/react/button",
        "@base-ui/react/checkbox",
        "@base-ui/react/dialog",
        "@base-ui/react/input",
        "@base-ui/react/menu",
        "@base-ui/react/merge-props",
        "@base-ui/react/popover",
        "@base-ui/react/select",
        "@base-ui/react/tabs",
        "@base-ui/react/use-render",
        "@tanstack/react-query",
        "class-variance-authority",
        "clsx",
        "date-fns",
        "@icons-pack/react-simple-icons",
        "lucide-react-upstream",
        "motion/react",
        "next-themes",
        "react",
        "react-day-picker",
        "react-dom/client",
        "react-is",
        "react-router-dom",
        "recharts-upstream",
        "sonner",
        "tailwind-merge",
      ],
    },
    server: {
      allowedHosts: true,
      host: true,
      port: 3000,
      hmr: hotReloadDisabled ? false : { overlay: true },
      watch: hotReloadDisabled ? null : undefined,
      // The /api proxy convention: frontend code calls relative /api/*, never an
      // absolute backend URL. Target is the FastAPI dev server (supervisor: backend).
      proxy: {
        "/api": {
          target: "http://localhost:8001",
          changeOrigin: true,
        },
      },
    },
  } satisfies UserConfig;
});

