#!/usr/bin/env node
/**
 * scripts/fetch-comps.js
 *
 * Fetches current meta comp stats from tactics.tools (public JSON API) and
 * merges the placement / win-rate / pick-rate numbers into data/comps.json.
 *
 * The script only updates the `stats` field of EXISTING comps by matching on
 * champion name overlap.  It never adds or removes comps automatically.
 *
 * A separate section queries the /api/pending-comps endpoint written by the
 * Vercel Edge Function to promote community submissions that have reached ≥3 votes.
 *
 * Usage:
 *   node scripts/fetch-comps.js
 *   node scripts/fetch-comps.js --dry-run
 *   node scripts/fetch-comps.js --site-url https://tft-guide.vercel.app
 *
 * Environment variables:
 *   SITE_URL — base URL of the deployed site (for fetching community submissions)
 */

"use strict";

const fs    = require("fs");
const path  = require("path");
const https = require("https");
const http  = require("http");

const ROOT      = path.resolve(__dirname, "..");
const COMPS_FILE = path.join(ROOT, "data", "comps.json");
const SCORES_FILE = path.join(ROOT, "data", "scores.json");

const ARGS     = process.argv.slice(2);
const DRY_RUN  = ARGS.includes("--dry-run");
const SITE_URL = (() => {
  const i = ARGS.indexOf("--site-url");
  return i >= 0 ? ARGS[i+1] : (process.env.SITE_URL || "");
})();

function get(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "TFT-Guide-bot/1.0 (+https://github.com/waiyanphyohein/TFT-Guide)",
        "Accept": "application/json",
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(get(res.headers.location, timeout));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
      });
      res.on("error", reject);
    });
    req.setTimeout(timeout, () => { req.destroy(new Error(`Timeout for ${url}`)); });
    req.on("error", reject);
  });
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// ── tactics.tools comp stats ──────────────────────────────────────────────────
// tactics.tools exposes their aggregated comp data at:
//   https://tactics.tools/api/comps?region=world&rank=diamond_plus
// The response is an array of comp objects with fields:
//   { name, avg_placement, top4_rate, win_rate, play_rate, units: [string, ...] }
// NOTE: If the endpoint changes or is unavailable the script exits gracefully.

const TACTICS_URL = "https://tactics.tools/api/comps?region=world&rank=diamond_plus";

async function fetchTacticsTools() {
  console.log(`Fetching comp stats from tactics.tools…`);
  await sleep(300);
  try {
    const data = await get(TACTICS_URL);
    if (!Array.isArray(data)) return [];
    return data.map(c => ({
      units:    c.units || [],
      place:    c.avg_placement ?? null,
      top4:     c.top4_rate   != null ? (c.top4_rate   * 100).toFixed(1) + "%" : null,
      win:      c.win_rate    != null ? (c.win_rate    * 100).toFixed(1) + "%" : null,
      pick:     c.play_rate   != null ? (c.play_rate   * 100).toFixed(2) + "%" : null,
    }));
  } catch (err) {
    console.warn(`tactics.tools fetch failed (${err.message}) — skipping stats update.`);
    return [];
  }
}

// ── Match external comps to our comps by unit overlap ────────────────────────

function overlap(setA, setB) {
  let count = 0;
  for (const u of setA) if (setB.has(u)) count++;
  return count;
}

function matchComp(ourComp, externalComps) {
  const ourUnits = new Set(ourComp.board);
  let bestScore = 0, bestMatch = null;
  for (const ext of externalComps) {
    const extUnits = new Set(ext.units);
    const score = overlap(ourUnits, extUnits);
    // require at least 5 units to overlap before accepting as a match
    if (score > bestScore && score >= 5) { bestScore = score; bestMatch = ext; }
  }
  return bestMatch;
}

// ── Community vote scores ─────────────────────────────────────────────────────
// Read vote tallies from the Vercel Edge Function /api/vote-scores

async function fetchVoteScores() {
  if (!SITE_URL) { console.log("SITE_URL not set — skipping vote scores."); return {}; }
  const url = `${SITE_URL.replace(/\/$/, "")}/api/vote-scores`;
  console.log(`Fetching vote scores from ${url}…`);
  await sleep(200);
  try {
    return await get(url);
  } catch (err) {
    console.warn(`Vote scores fetch failed (${err.message}) — skipping.`);
    return {};
  }
}

// ── Community submissions ─────────────────────────────────────────────────────

async function fetchPendingComps() {
  if (!SITE_URL) return [];
  const url = `${SITE_URL.replace(/\/$/, "")}/api/pending-comps`;
  console.log(`Fetching pending comps from ${url}…`);
  await sleep(200);
  try {
    const data = await get(url);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`Pending comps fetch failed (${err.message}) — skipping.`);
    return [];
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const existing     = JSON.parse(fs.readFileSync(COMPS_FILE, "utf8"));
  const comps        = existing.comps;

  const [externalComps, voteScores, pendingComps] = await Promise.all([
    fetchTacticsTools(),
    fetchVoteScores(),
    fetchPendingComps(),
  ]);

  let statsUpdated = 0;
  let compsAdded   = 0;

  // Update stats on existing comps
  for (const comp of comps) {
    if (externalComps.length) {
      const match = matchComp(comp, externalComps);
      if (match && match.place != null) {
        const prev = JSON.stringify(comp.stats || {});
        comp.stats = { place: match.place, top4: match.top4, win: match.win, pick: match.pick };
        if (JSON.stringify(comp.stats) !== prev) statsUpdated++;
      }
    }
  }

  // Promote pending community comps that have reached ≥3 votes
  const existingNames = new Set(comps.map(c => c.n));
  for (const pending of pendingComps) {
    if ((pending.votes ?? 0) < 3) continue;
    if (existingNames.has(pending.n)) continue; // already present
    comps.push({
      ...pending,
      src: "community", k: pending.k || "hy", slug: pending.slug || "",
      diff:  pending.diff  || "",
      style: pending.style || "",
      alts:  pending.alts  || [],
      carries: pending.carries || [],
      when:  pending.when  || [],
      tips:  pending.tips  || [],
      board: pending.board || [],
      by:    pending.by    || "",
    });
    compsAdded++;
    existingNames.add(pending.n);
    console.log(`  + Added community comp: ${pending.n} (${pending.votes} votes)`);
  }

  // Write vote scores for the build script
  if (Object.keys(voteScores).length) {
    if (!DRY_RUN) {
      fs.writeFileSync(SCORES_FILE, JSON.stringify(voteScores, null, 2), "utf8");
      console.log(`Wrote data/scores.json — ${Object.keys(voteScores).length} entries`);
    } else {
      console.log("DRY RUN: would write data/scores.json");
    }
  }

  if (DRY_RUN) {
    console.log(`=== DRY RUN — not writing data/comps.json ===`);
    console.log(`Stats updated: ${statsUpdated}, comps added: ${compsAdded}`);
    return;
  }

  const updated = { ...existing, comps, _meta: { ...existing._meta, updatedAt: new Date().toISOString().slice(0,10) } };
  fs.writeFileSync(COMPS_FILE, JSON.stringify(updated, null, 2), "utf8");
  console.log(`Wrote data/comps.json — ${comps.length} comps, ${statsUpdated} stats updated, ${compsAdded} comps added`);

  // GitHub Actions summary
  const summary = [
    "## Comp Stats Update",
    `- Stats updated: **${statsUpdated}** comps`,
    compsAdded ? `- ✅ **New community comps promoted**: ${compsAdded}` : "",
    `- Vote scores: ${Object.keys(voteScores).length} entries`,
  ].filter(Boolean).join("\n");

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) fs.appendFileSync(summaryFile, summary + "\n");
  else console.log(summary);
}

main().catch(err => { console.error(err); process.exit(1); });
