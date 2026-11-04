import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
const bff = `http://127.0.0.1:${process.env.BFF_PORT ?? 8790}`;
export default defineConfig({ plugins: [react(), tailwindcss()], server: { port: 5180, strictPort: true, proxy: { "/api": { target: bff, rewrite: (p) => p.replace(/^\/api/, "") } } } });
