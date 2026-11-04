import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
const bff = `http://127.0.0.1:${process.env.BFF_PORT ?? 8790}`;
/** Vendor chunks so no single file carries every library. Pages are split per route in App.tsx. */
const VENDOR: [string, RegExp][] = [
  ["charts", /node_modules\/(recharts|d3-[^/]+|victory-vendor|internmap|decimal\.js-light|lodash|react-smooth|recharts-scale|eventemitter3|tiny-invariant|fast-equals)\//],
  ["xyflow", /node_modules\/(@xyflow|d3-(drag|selection|zoom|dispatch|interpolate|color|ease|timer|transition)|classcat|zustand)\//],
  ["cmdk", /node_modules\/(cmdk|@radix-ui|@floating-ui|react-remove-scroll|react-remove-scroll-bar|react-style-singleton|use-callback-ref|use-sidecar|aria-hidden|tslib)\//],
  ["tanstack", /node_modules\/@tanstack\//],
  ["react", /node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@remix-run)\//],
];
/** Pre-bundle every runtime dep at start. When Vite finds a new dep mid session it re-optimizes and changes the ?v= hash, so a tab that is already open loads a second React copy and throws "Invalid hook call". */
const PREBUNDLE = ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "react-router-dom", "@tanstack/react-query", "@tanstack/react-table", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-slot", "@xyflow/react", "recharts", "cmdk", "lucide-react", "clsx", "tailwind-merge", "class-variance-authority", "zod"];
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: { include: PREBUNDLE },
  server: { port: 5180, strictPort: true, proxy: { "/api": { target: bff, rewrite: (p) => p.replace(/^\/api/, "") } } },
  build: { rollupOptions: { output: { manualChunks(id) { const p = id.replace(/\\/g, "/"); for (const [name, re] of VENDOR) if (re.test(p)) return name; return undefined; } } } },
});
