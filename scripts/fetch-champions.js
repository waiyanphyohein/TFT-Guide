#!/usr/bin/env node
/**
 * scripts/fetch-champions.js
 *
 * Fetches TFT champion and item data from Riot's Data Dragon and merges it with
 * the existing data/champions.json, preserving hand-curated BIS/meta builds and
 * writing updated champion stats.
 *
 * Usage:
 *   node scripts/fetch-champions.js
 *   node scripts/fetch-champions.js --set 18
 *   node scripts/fetch-champions.js --dry-run   (print diff, don't write)
 *
 * AP/AD classification rules (keyword scan of ability description):
 *   ADAPTOR  — trait string includes "Adaptor"
 *   AP       — description contains "magic damage" or role starts with "AP"
 *   AD       — description contains "physical damage" or role starts with "AD"
 *   AMBIGUOUS — anything else → flagged for human review
 *
 * The script writes a summary of ambiguous champions to STDOUT for the GitHub
 * Actions job summary.
 */

"use strict";

const fs    = require("fs");
const path  = require("path");
const https = require("https");

const ROOT       = path.resolve(__dirname, "..");
const DATA_FILE  = path.join(ROOT, "data", "champions.json");
const FLAGS_FILE = path.join(ROOT, "data", "classification-flags.json");

const ARGS    = process.argv.slice(2);
const DRY_RUN = ARGS.includes("--dry-run");
const SET_ARG = (() => { const i = ARGS.indexOf("--set"); return i >= 0 ? ARGS[i+1] : null; })();

// ── helpers ──────────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "TFT-Guide-bot/1.0 (+https://github.com/waiyanphyohein/TFT-Guide)" } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(get(res.headers.location));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// ── AP/AD classification ──────────────────────────────────────────────────────

const AP_KEYWORDS  = ["magic damage","magic dmg","ability power","ap damage","ap magic"];
const AD_KEYWORDS  = ["physical damage","physical dmg","% ad","attack damage","ad damage"];

function classify(champion) {
  const desc  = (champion.d || "").toLowerCase();
  const role  = (champion.r || "").toLowerCase();
  const trait = (champion.t || "").toLowerCase();

  if (trait.includes("adaptor")) return { side: "fx", ambiguous: false };

  const hasAP = AP_KEYWORDS.some(k => desc.includes(k)) || role.startsWith("ap");
  const hasAD = AD_KEYWORDS.some(k => desc.includes(k)) || role.startsWith("ad");

  if (hasAP && !hasAD) return { side: "ap", ambiguous: false };
  if (hasAD && !hasAP) return { side: "ad", ambiguous: false };
  if (hasAP && hasAD)  return { side: role.startsWith("ap") ? "ap" : "ad", ambiguous: true };
  return { side: "ad", ambiguous: true };
}

// ── Data Dragon fetch ─────────────────────────────────────────────────────────

async function fetchLatestVersion() {
  const versions = await get("https://ddragon.leagueoflegends.com/api/versions.json");
  return versions[0];
}

async function fetchTFTChampions(version, setNumber) {
  // Data Dragon TFT champions endpoint
  const url = `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/tft-champion.json`;
  console.log(`Fetching champions from ${url}`);
  await sleep(500);
  const data = await get(url);

  // Filter to the requested set
  const champions = Object.values(data.data).filter(c => {
    if (!setNumber) return true;
    const setNum = parseInt(c.set, 10);
    return setNum === parseInt(setNumber, 10);
  });

  return champions;
}

// ── Map Data Dragon champion to our schema ────────────────────────────────────

function mapDDragonChampion(dd) {
  const tier = dd.tier != null ? parseInt(dd.tier, 10) : 0;
  const traits = (dd.traits || []).join(" · ");

  // Heuristic role from traits and ability
  const desc    = (dd.ability?.desc || "").toLowerCase();
  const isAP    = AP_KEYWORDS.some(k => desc.includes(k));
  const isAD    = AD_KEYWORDS.some(k => desc.includes(k));
  const role    = isAP && !isAD ? "AP Caster" : !isAP && isAD ? "AD Carry" : "AD Carry";

  return {
    n:  dd.name,
    c:  tier,
    r:  role,
    t:  traits,
    a:  dd.ability?.name || "",
    d:  dd.ability?.desc || "",
    hp: dd.stats?.hp   ?? null,
    ms: dd.stats?.initialMana ?? 0,
    mm: dd.stats?.mana ?? 0,
    ad: dd.stats?.damage ?? 0,
    ar: dd.stats?.armor ?? 0,
    mr: dd.stats?.magicResist ?? 0,
    img: dd.image?.full?.replace(".png","") || "",
  };
}

// ── Merge with existing data ──────────────────────────────────────────────────

function mergeChampions(existing, incoming) {
  const existingByName = Object.fromEntries(existing.map(c => [c.n, c]));
  const ambiguous      = [];
  const added          = [];
  const changed        = [];

  const merged = incoming.map(dd => {
    const mapped = mapDDragonChampion(dd);
    const prev   = existingByName[mapped.n];

    // Classify
    const { side, ambiguous: isAmbiguous } = classify(mapped);
    if (isAmbiguous) ambiguous.push({ name: mapped.n, side, desc: mapped.d.slice(0, 120) });

    if (!prev) {
      added.push(mapped.n);
      return mapped;
    }

    // Preserve hand-curated role if it exists and we can't improve it
    const updatedRole = mapped.r && mapped.r !== "AD Carry" ? mapped.r : prev.r;

    // Keep existing description/ability text if Data Dragon's is empty or shorter
    const updatedDesc  = (mapped.d && mapped.d.length > (prev.d || "").length) ? mapped.d : prev.d;
    const updatedAbil  = mapped.a || prev.a;

    // Track stat changes
    const statKeys = ["hp","ms","mm","ad","ar","mr"];
    const hasChange = statKeys.some(k => mapped[k] !== prev[k]);
    if (hasChange) changed.push(mapped.n);

    return { ...prev, ...mapped, r: updatedRole, d: updatedDesc, a: updatedAbil };
  });

  return { merged, ambiguous, added, changed };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const existing = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const meta     = existing._meta;

  let version;
  try {
    version = await fetchLatestVersion();
    console.log(`Latest Data Dragon version: ${version}`);
  } catch (err) {
    console.error("Could not fetch Data Dragon version:", err.message);
    process.exit(0); // non-fatal: keep existing data
  }

  // Derive set number from current set name or --set argument
  const setNumber = SET_ARG || meta.set;

  let ddChampions;
  try {
    ddChampions = await fetchTFTChampions(version, setNumber);
  } catch (err) {
    console.error("Could not fetch champion data:", err.message);
    process.exit(0);
  }

  if (!ddChampions.length) {
    console.log(`No champions found for set ${setNumber} in Data Dragon ${version} — keeping existing data.`);
    process.exit(0);
  }

  const { merged, ambiguous, added, changed } = mergeChampions(existing.champions, ddChampions);

  // Update patch from version string (e.g. "14.15.1" → "14.15")
  const patchParts = version.split(".");
  const newPatch   = patchParts.slice(0, 2).join(".");

  const updated = {
    ...existing,
    _meta: { ...meta, patch: newPatch, updatedAt: new Date().toISOString().slice(0,10), ddVersion: version },
    champions: merged,
  };

  // Write classification flags for human review
  const flags = { ambiguous, added, changed, ddVersion: version, generatedAt: new Date().toISOString() };
  fs.writeFileSync(FLAGS_FILE, JSON.stringify(flags, null, 2), "utf8");

  if (DRY_RUN) {
    console.log("=== DRY RUN — not writing data/champions.json ===");
    console.log(`Champions: ${existing.champions.length} → ${merged.length}`);
    console.log(`Added: ${added.join(", ") || "none"}`);
    console.log(`Changed stats: ${changed.join(", ") || "none"}`);
  } else {
    fs.writeFileSync(DATA_FILE, JSON.stringify(updated, null, 2), "utf8");
    console.log(`Wrote data/champions.json — ${merged.length} champions, patch ${newPatch}`);
  }

  // GitHub Actions job summary
  const summary = [
    `## Champion Data Update`,
    `- Data Dragon version: \`${version}\``,
    `- Patch string: \`${newPatch}\``,
    `- Champions: **${existing.champions.length} → ${merged.length}**`,
    added.length   ? `- ✅ **New champions** (${added.length}): ${added.join(", ")}` : "",
    changed.length ? `- 🔄 **Stat changes** (${changed.length}): ${changed.join(", ")}` : "",
    ambiguous.length ? [
      `\n### ⚠️ Ambiguous AP/AD classification (${ambiguous.length}) — please review`,
      "| Champion | Guessed | Ability snippet |",
      "|----------|---------|-----------------|",
      ...ambiguous.map(a => `| ${a.name} | ${a.side} | ${a.desc.replace(/\|/g,"\\|")} |`),
    ].join("\n") : "",
  ].filter(Boolean).join("\n");

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) fs.appendFileSync(summaryFile, summary + "\n");
  else console.log(summary);

  // Exit non-zero if there are ambiguous champions that need human review AND new champions were added
  // (stats-only changes are always safe to auto-deploy)
  if (added.length && ambiguous.length) {
    console.warn("⚠ New champions with ambiguous classification detected — PR requires human review.");
    process.exitCode = 2;
  }
}

main().catch(err => { console.error(err); process.exit(1); });
