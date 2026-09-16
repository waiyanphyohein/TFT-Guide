/**
 * api/pending-comps.js — Vercel Edge Function
 *
 * GET /api/pending-comps?patch=<patch>
 *
 * Returns pending community comp submissions that have accumulated ≥3 votes.
 * Called by the daily GitHub Actions workflow (fetch-comps.js) to promote
 * submissions into data/comps.json.
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
    return new Response(JSON.stringify([]), {
      status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }

  const url   = new URL(req.url);
  const patch = url.searchParams.get("patch") || "*";

  // Scan for all pending keys for this patch
  const pattern = "pending:" + patch + ":*";
  let keys = [];
  try {
    const scan = await kv("GET", "/scan/0?match=" + encodeURIComponent(pattern) + "&count=200");
    keys = (scan && scan.result && scan.result[1]) ? scan.result[1] : [];
  } catch (err) {
    return new Response("KV error: " + err.message, { status: 502 });
  }

  // Filter to data keys only (not vote-count or IP keys)
  const dataKeys = keys.filter(k => !k.endsWith(":votes") && !k.includes("ip-"));

  // Fetch data + votes in parallel
  const results = await Promise.allSettled(
    dataKeys.map(async key => {
      const voteKey = key + ":votes";
      const [dataRes, votesRes] = await Promise.all([
        kv("GET", "/get/" + key),
        kv("GET", "/get/" + voteKey).catch(() => ({ result: 0 })),
      ]);
      const data  = dataRes && dataRes.result ? JSON.parse(dataRes.result) : null;
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
