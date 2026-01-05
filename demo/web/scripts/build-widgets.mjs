import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..");
const DEMO_DIR = path.resolve(WEB_DIR, "..");
const ASSETS_DIR = path.resolve(DEMO_DIR, "assets");

/**
 * Why this exists (demo): a single script generates a standalone HTML file per widget entrypoint.
 * This keeps the “widget as a single resource” model simple while still letting you split UI into many files.
 */
const widgets = [
  { assetName: "demo-prompts", entry: path.join(WEB_DIR, "src/widgets/prompts.tsx"), title: "Prompt Library Widget" },
  { assetName: "demo-insights", entry: path.join(WEB_DIR, "src/widgets/insights.tsx"), title: "Prompt Insights Widget" },
];

fs.mkdirSync(ASSETS_DIR, { recursive: true });

for (const widget of widgets) {
  const result = await esbuild.build({
    entryPoints: [widget.entry],
    bundle: true,
    write: false,
    format: "esm",
    target: ["es2018"],
    jsx: "automatic",
    loader: { ".ts": "ts", ".tsx": "tsx", ".css": "css" },
    minify: true,
    outdir: "/out",
    entryNames: widget.assetName,
  });

  const jsFile = result.outputFiles.find((f) => f.path.endsWith(`${widget.assetName}.js`));
  const cssFile = result.outputFiles.find((f) => f.path.endsWith(`${widget.assetName}.css`));

  const js = jsFile?.text ?? "";
  const css = cssFile?.text ?? "";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${widget.title}</title>
    <style>${css}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
${js}
    </script>
  </body>
</html>
`;

  fs.writeFileSync(path.join(ASSETS_DIR, `${widget.assetName}.html`), html, "utf8");
  console.log(`Wrote ${widget.assetName}.html`);
}

