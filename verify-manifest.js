const { readFileSync } = require("fs");
const path = require("path");

const manifestPath = path.join(__dirname, "manifest.json");
const raw = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(raw);

if (manifest.icons) {
  throw new Error("manifest.json still declares an 'icons' block; remove it to avoid Chrome looking for icon assets.");
}

const iconFileMatch = raw.match(/icon\d+\.png|icon\d+\.svg/i);
if (iconFileMatch) {
  throw new Error(`manifest.json references an icon file: ${iconFileMatch[0]}`);
}

console.log("manifest.json is icon-free and ready for loading.");
