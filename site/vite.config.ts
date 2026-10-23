import { resolve } from "node:path";
import { defineConfig } from "vite";

// Three pages: the landing page and the two legal pages (served as /terms and /privacy,
// vercel.json cleanUrls).
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        terms: resolve(import.meta.dirname, "terms.html"),
        privacy: resolve(import.meta.dirname, "privacy.html"),
      },
    },
  },
});
