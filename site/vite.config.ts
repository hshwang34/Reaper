import { resolve } from "node:path";
import { defineConfig } from "vite";

// Five pages: the landing page, the download page, the setup guide and the two legal pages
// (served as /download, /setup, /terms and /privacy via vercel.json cleanUrls).
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        terms: resolve(import.meta.dirname, "terms.html"),
        privacy: resolve(import.meta.dirname, "privacy.html"),
        download: resolve(import.meta.dirname, "download.html"),
        setup: resolve(import.meta.dirname, "setup.html"),
      },
    },
  },
});
