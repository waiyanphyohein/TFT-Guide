/**
 * api/pending-comps.js — Vercel Edge Function
 *
 * GET /api/pending-comps?patch=<patch>
 *
 * Returns pending community comp submissions with ≥3 votes.
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

const PROMOTE_THRESHOLD = 3;

function kvUrl(p) { return process.env.KV_REST_API_URL + p; }

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
    return new Response(JSON.stringify([]), {
      status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }

  const url   = new URL(req.url);
  const patch = url.searchParams.get("patch") || "*";

  let keys;
  try {
    keys = await scanAllKeys("pending:" + patch + ":*");
  } catch (err) {
    return new Response("KV scan error: " + err.message, { status: 502 });
  }

  // Only data keys (not :<slug>:votes or ip- keys)
  const dataKeys = keys.filter(k => !k.endsWith(":votes") && !k.includes("ip-"));

  // Fetch data + votes in parallel
  const results = await Promise.allSettled(
    dataKeys.map(async key => {
      const voteKey = key + ":votes";
      const [dataRes, votesRes] = await Promise.all([
        kvGet("/get/" + key),
        kvGet("/get/" + voteKey).catch(() => ({ result: 0 })),
      ]);
      const data  = (dataRes && dataRes.result) ? JSON.parse(dataRes.result) : null;
      const votes = (votesRes && votesRes.result) ? parseInt(votesRes.result, 10) : 0;
      return data ? { ...data, votes } : null;
    })
  );

  const promoted = results
    .filter(r => r.status === "fulfilled" && r.value && r.value.votes >= PROMOTE_THRESHOLD)
    .map(r => r.value);

  return new Response(JSON.stringify(promoted), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
