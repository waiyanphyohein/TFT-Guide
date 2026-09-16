/**
 * api/vote-scores.js — Vercel Edge Function
 *
 * GET /api/vote-scores
 *
 * Returns a JSON object mapping comp name → net score (upvotes − downvotes)
 * for the current patch. Used by the daily GitHub Actions workflow to write
 * data/scores.json before rebuilding the page.
 *
 * The patch is read from the ?patch= query parameter or defaults to fetching
 * all keys matching the vote:* pattern.
 *
 * Environment variables required:
 *   KV_REST_API_URL
 *   KV_REST_API_TOKEN
 */

export const config = { runtime: "edge" };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function kvUrl(p) {
  return process.env.KV_REST_API_URL + p;
}

async function kv(method, p) {
  const res = await fetch(kvUrl(p), {
    method,
    headers: { Authorization: "Bearer " + process.env.KV_REST_API_TOKEN },
  });
  if (!res.ok) throw new Error("KV " + method + " " + p + " -> " + res.status);
  return res.json();
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET")     return new Response("Method Not Allowed", { status: 405 });

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return new Response(JSON.stringify({}), {
      status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }

  const url    = new URL(req.url);
  const patch  = url.searchParams.get("patch") || "*";
  const cursor = url.searchParams.get("cursor") || "0";

  // SCAN for all vote keys (pattern: vote:<patch>:*:up|down)
  const pattern = "vote:" + patch + ":*";
  let keys = [];
  try {
    const scan = await kv("GET", "/scan/" + cursor + "?match=" + encodeURIComponent(pattern) + "&count=200");
    keys = (scan && scan.result && scan.result[1]) ? scan.result[1] : [];
  } catch (err) {
    return new Response("KV error: " + err.message, { status: 502 });
  }

  // Fetch all values in parallel
  const entries = await Promise.allSettled(
    keys.map(async key => {
      const res = await kv("GET", "/get/" + key);
      return { key, value: (res && res.result) ? parseInt(res.result, 10) : 0 };
    })
  );

  // Aggregate into { compName: netScore }
  const scores = {};
  for (const entry of entries) {
    if (entry.status !== "fulfilled") continue;
    const { key, value } = entry.value;
    // key format: vote:<patch>:<comp-slug>:<direction>
    const parts = key.split(":");
    if (parts.length < 4) continue;
    const slug = parts.slice(2, -1).join(":");
    const dir  = parts[parts.length - 1];
    if (!scores[slug]) scores[slug] = 0;
    scores[slug] += dir === "up" ? value : -value;
  }

  return new Response(JSON.stringify(scores), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
