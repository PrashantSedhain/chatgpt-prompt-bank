import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, "..")
const DIST_DIR = path.join(ROOT_DIR, "dist")
const ASSETS_DIR = path.resolve(ROOT_DIR, "..", "assets")

function loadEnvFromServerDotEnv() {
  const dotEnvPath = path.resolve(ROOT_DIR, "..", "server", ".env")
  if (!fs.existsSync(dotEnvPath)) return
  const contents = fs.readFileSync(dotEnvPath, "utf8")
  for (const line of contents.split(/\r?\n/g)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const exportMatch = trimmed.match(/^export\s+([A-Z0-9_]+)=(.*)$/)
    const plainMatch = trimmed.match(/^([A-Z0-9_]+)=(.*)$/)
    const match = exportMatch ?? plainMatch
    if (!match) continue
    const key = match[1]
    if (process.env[key] != null) continue
    let value = match[2].trim()
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

function sanitizeVersion(value) {
  const cleaned = String(value ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, "")
  return cleaned || undefined
}

loadEnvFromServerDotEnv()

const widgetVersion = sanitizeVersion(process.env.WIDGET_VERSION)
if (!widgetVersion) {
  throw new Error(
    `Missing WIDGET_VERSION. Set it in server/.env (export WIDGET_VERSION="23") or pass it as an env var when building.`,
  )
}
const baseName = `prompt-suggestions-${widgetVersion}`
const htmlPath = path.join(ASSETS_DIR, `${baseName}.html`)
const legacyHtmlPath = path.join(ASSETS_DIR, "prompt-suggestions.html")

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
if (fs.existsSync(legacyHtmlPath)) {
  try {
    fs.rmSync(legacyHtmlPath, { force: true })
  } catch {
    fs.unlinkSync(legacyHtmlPath)
  }
}

console.log(`Wrote widget HTML to ${htmlPath}`)
console.log(`Removed legacy widget HTML alias at ${legacyHtmlPath}`)
