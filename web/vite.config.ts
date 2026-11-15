import { defineConfig } from "vite";
// Relative base so the build works from any GitHub Pages sub-path.
export default defineConfig({ base: "./", build: { outDir: "../dist", emptyOutDir: true, target: "es2020" } });
