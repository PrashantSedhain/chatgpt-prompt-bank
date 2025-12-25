import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, "..")
const DIST_DIR = path.join(ROOT_DIR, "dist")
const ASSETS_DIR = path.resolve(ROOT_DIR, "..", "assets")

const htmlPath = path.join(ASSETS_DIR, "prompt-suggestions.html")

if (!fs.existsSync(DIST_DIR)) {
  throw new Error(`Missing dist directory at ${DIST_DIR}. Run "npm run build" first.`)
}

const cssPath = path.join(DIST_DIR, "component.css")
const jsPath = path.join(DIST_DIR, "component.js")

if (!fs.existsSync(cssPath) || !fs.existsSync(jsPath)) {
  throw new Error(`Expected dist/component.css and dist/component.js to exist. Run "npm run build".`)
}

const css = fs.readFileSync(cssPath, "utf8")
const js = fs.readFileSync(jsPath, "utf8")

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Prompt Suggestions</title>
    <style>${css}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
${js}
    </script>
  </body>
</html>
`

fs.mkdirSync(ASSETS_DIR, { recursive: true })
fs.writeFileSync(htmlPath, html, "utf8")

console.log(`Wrote widget HTML to ${htmlPath}`)
