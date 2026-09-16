#!/usr/bin/env node
/**
 * build.js — Generate dist/index.html from template/page.html + data/*.json
 *
 * Usage:
 *   node build.js
 *   node build.js --watch        (rebuild on data/template changes)
 *
 * The template file contains a single line:
 *   // __INJECT_DATA__
 * which is replaced with JS const assignments for every data object.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

const ROOT     = path.resolve(__dirname);
const TEMPLATE = path.join(ROOT, "template", "page.html");
const DIST_DIR = path.join(ROOT, "dist");
const DIST_OUT = path.join(DIST_DIR, "index.html");

// Data files to inject. Order matters: later files can reference earlier ones.
// DATA_FILES documents which data/ files feed which JS variables (for reference):
// items.json     → COMPONENTS, BANDS, TELLS
// champions.json → CHAMPS, BIS, META_BUILDS, IMGBASE
// comps.json     → COMPS, SRC, COMPBASE
// Optional: merge community-score overrides written by the daily workflow
const SCORE_FILE = path.join(ROOT, "data", "scores.json");

function loadJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function buildDataBlock() {
  const items    = loadJSON(path.join(ROOT, "data", "items.json"));
  const champs   = loadJSON(path.join(ROOT, "data", "champions.json"));
  const compsRaw = loadJSON(path.join(ROOT, "data", "comps.json"));

  // Load optional community vote scores and apply them
  let scores = {};
  if (fs.existsSync(SCORE_FILE)) {
    scores = loadJSON(SCORE_FILE);
  }

  // Apply vote scores to comps: add communityScore field, sort promoted comps higher
  const comps = compsRaw.comps.map(cp => {
    const sc = scores[cp.n];
    return sc !== undefined ? { ...cp, communityScore: sc } : cp;
  });

  // Sort: within each src group, higher communityScore first; negative scores last
  const srcOrder = { meta: 0, stats: 1, community: 2 };
  comps.sort((a, b) => {
    const so = (srcOrder[a.src] ?? 9) - (srcOrder[b.src] ?? 9);
    if (so !== 0) return so;
    const sa = a.communityScore ?? 0;
    const sb = b.communityScore ?? 0;
    return sb - sa;
  });

  // Mark comps as stale when communityScore is −5 or below
  comps.forEach(cp => {
    if ((cp.communityScore ?? 0) <= -5) cp.stale = true;
  });

  // Build the IMG lookup from champion data
  const img = {};
  champs.champions.forEach(c => { img[c.n] = c.img; });

  const imgBase  = "https://tftraits.com/assets/set18/champions/";
  const itemBase = items._meta.itemImgBase;
  const compBase = compsRaw._meta.compBase;
  const patchStr = champs._meta.patch;
  const setName  = champs._meta.setName;

  // Flatten champions: strip img field (it's in IMG map), keep rest
  const champArr = champs.champions.map(({ img: _img, ...rest }) => rest);

  const lines = [
    `/* === AUTO-GENERATED — do not edit. Run: node build.js === */`,
    `const _PATCH = ${JSON.stringify(patchStr)};`,
    `const _SET_NAME = ${JSON.stringify(setName)};`,
    `const IMGBASE = ${JSON.stringify(imgBase)};`,
    `const ITEMBASE = ${JSON.stringify(itemBase)};`,
    `const COMPBASE = ${JSON.stringify(compBase)};`,
    `const IMG = ${JSON.stringify(img, null, 0)};`,
    `const CHAMPS = ${JSON.stringify(champArr)};`,
    `const BIS = ${JSON.stringify(champs.bis, null, 0)};`,
    `const META = ${JSON.stringify(champs.meta, null, 0)};`,
    `const METASRC = "https://mobalytics.gg/tft/team-comps";`,
    `const BANDS = ${JSON.stringify(items.bands)};`,
    `const COMP  = Object.fromEntries(Object.entries(${JSON.stringify(items.components)}).map(([k,[n,s,_img]]) => [k,[n,s]]));`,
    `const COMPIMG = Object.fromEntries(Object.entries(${JSON.stringify(items.components)}).map(([k,[_n,_s,img]]) => [k,img]));`,
    `const ITEMIMG = Object.fromEntries(${JSON.stringify(items.bands)}.flatMap(b => b.items.map(([name,,,, slug]) => [name, slug])));`,
    `const TELLS = ${JSON.stringify(items.tells)};`,
    `const SRC = ${JSON.stringify(compsRaw._meta.sources, null, 0)};`,
    `const COMPS = ${JSON.stringify(comps)};`,
  ];

  return lines.join("\n");
}

function build() {
  if (!fs.existsSync(TEMPLATE)) {
    console.error(`ERROR: template not found at ${TEMPLATE}`);
    process.exit(1);
  }

  let html = fs.readFileSync(TEMPLATE, "utf8");

  // Check the placeholder is present
  if (!html.includes("// __INJECT_DATA__")) {
    console.error('ERROR: template is missing the "// __INJECT_DATA__" placeholder.');
    process.exit(1);
  }

  const block = buildDataBlock();
  html = html.replace("// __INJECT_DATA__", block);

  // Update the patch stamp dynamically
  const champs = loadJSON(path.join(ROOT, "data", "champions.json"));
  const patchStr = champs._meta.patch;
  const setName  = champs._meta.setName;
  html = html.replace(/__PATCH__/g, patchStr);
  html = html.replace(/__SET_NAME__/g, setName);

  if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(DIST_OUT, html, "utf8");
  console.log(`[build] Written ${DIST_OUT} (${Math.round(html.length / 1024)} KB)`);
}

// ── watch mode ──────────────────────────────────────────────────────────────
if (process.argv.includes("--watch")) {
  const chokidar = (() => { try { return require("chokidar"); } catch { return null; } })();
  if (!chokidar) {
    console.error("Install chokidar for watch mode: npm install -D chokidar");
    process.exit(1);
  }
  build();
  chokidar.watch(["data", "template"], { cwd: ROOT, ignoreInitial: true }).on("all", () => {
    console.log("[watch] change detected, rebuilding…");
    build();
  });
} else {
  build();
}
