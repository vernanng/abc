import { defineConfig } from "vite";

// Console SPA (SPEC Phase A). Plain Preact with the classic JSX runtime -
// no extra Vite plugins.
export default defineConfig({
  oxc: { jsx: { runtime: "classic", pragma: "h", pragmaFrag: "Fragment" } },
  build: { outDir: "dist" },
});
