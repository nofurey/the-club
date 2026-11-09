import { createReadStream, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);
const ocrModel = join(dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int", "eng.traineddata.gz");

export default defineConfig({
  root: "web",
  plugins: [react(), {
    name: "local-ocr-model",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/ocr/eng.traineddata.gz") return next();
        response.setHeader("Content-Type", "application/gzip");
        createReadStream(ocrModel).pipe(response);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "ocr/eng.traineddata.gz", source: readFileSync(ocrModel) });
    },
  }],
  server: {
    host: "0.0.0.0",
    proxy: { "/api": "http://127.0.0.1:8080" },
  },
  build: { outDir: "../dist-web", emptyOutDir: true },
});