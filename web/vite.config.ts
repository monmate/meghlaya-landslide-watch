import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" lets the site work under GitHub Pages' /<repo>/ path.
export default defineConfig({
  base: "./",
  plugins: [react()],
  worker: { format: "es" },
  build: { chunkSizeWarningLimit: 1500 },
});
