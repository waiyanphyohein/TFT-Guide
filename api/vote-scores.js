/**
 * api/vote-scores.js — Vercel Edge Function
 *
 * GET /api/vote-scores?patch=<patch>
 *
 * Returns a JSON object mapping comp slug → net score (upvotes − downvotes).
 * Fully paginates the KV SCAN to avoid missing keys beyond the first page.
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

async function kvGet(p) {
  const res = await fetch(kvUrl(p), {
    method: "GET",
    headers: { Authorization: "Bearer " + process.env.KV_REST_API_TOKEN },
  });
  if (!res.ok) throw new Error("KV GET " + p + " -> " + res.status);
  return res.json();
}

async function scanAllKeys(pattern) {
  const keys = [];
  let cursor = "0";
  do {
    const result = await kvGet(
      "/scan/" + cursor + "?match=" + encodeURIComponent(pattern) + "&count=200"
    );
    const [nextCursor, page] = (result && result.result) ? result.result : ["0", []];
    if (Array.isArray(page)) keys.push(...page);
    cursor = String(nextCursor);
  } while (cursor !== "0");
  return keys;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "GET")     return new Response("Method Not Allowed", { status: 405 });

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return new Response(JSON.stringify({}), {
      status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }

  const url   = new URL(req.url);
  const patch = url.searchParams.get("patch") || "*";

  let keys;
  try {
    keys = await scanAllKeys("vote:" + patch + ":*");
  } catch (err) {
    return new Response("KV scan error: " + err.message, { status: 502 });
  }

  // Fetch all values in parallel
  const entries = await Promise.allSettled(
    keys.map(async key => {
      const res = await kvGet("/get/" + key);
      return { key, value: (res && res.result) ? parseInt(res.result, 10) : 0 };
    })
  );

  // Aggregate into { compSlug: netScore }
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
