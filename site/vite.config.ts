import { resolve } from "node:path";
import { defineConfig } from "vite";

// Four pages: the landing page, the setup guide and the two legal pages (served as /setup,
// /terms and /privacy via vercel.json cleanUrls).
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        terms: resolve(import.meta.dirname, "terms.html"),
        privacy: resolve(import.meta.dirname, "privacy.html"),
        setup: resolve(import.meta.dirname, "setup.html"),
      },
    },
  },
});
