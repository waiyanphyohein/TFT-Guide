/**
 * api/vote.js — Vercel Edge Function
 *
 * POST /api/vote
 * Body: { comp: string, vote: "up"|"down", patch: string }
 *
 * Stores votes in Vercel KV (REDIS) and returns the updated score for the comp.
 *
 * Environment variables required (set in Vercel dashboard):
 *   KV_REST_API_URL   — from Vercel KV integration
 *   KV_REST_API_TOKEN — from Vercel KV integration
 *
 * Key schema:
 *   vote:<patch>:<compSlug>:up   → integer (upvote count)
 *   vote:<patch>:<compSlug>:down → integer (downvote count)
 *
 * Rate-limiting: one vote per (comp, direction) per IP per patch cycle.
 *   ip-vote:<ip>:<patch>:<compSlug>:<direction> → "1" (TTL: 30 days)
 */

export const config = { runtime: "edge" };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function kvUrl(p) {
  return process.env.KV_REST_API_URL + p;
}

async function kv(method, p, body) {
  const res = await fetch(kvUrl(p), {
    method,
    headers: {
      Authorization: "Bearer " + process.env.KV_REST_API_TOKEN,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error("KV " + method + " " + p + " -> " + res.status);
  return res.json();
}

async function kvIncr(key)          { return kv("POST", "/incr/" + key); }
async function kvSetex(key, ttl, v) { return kv("POST", "/setex/" + key + "/" + ttl + "/" + v); }
async function kvGet(key)           { return kv("GET",  "/get/"  + key); }
async function kvExists(key)        { return kv("GET",  "/exists/" + key); }

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST")    return new Response("Method Not Allowed", { status: 405 });

  let body;
  try { body = await req.json(); }
  catch { return new Response("Bad Request", { status: 400 }); }

  const { comp, vote, patch } = body;
  if (!comp || !["up","down"].includes(vote) || !patch) {
    return new Response("Missing or invalid fields", { status: 422 });
  }

  // Return gracefully if KV is not configured (local dev / preview without KV)
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.warn("KV not configured — vote not stored");
    return new Response(JSON.stringify({ ok: true, score: 0 }), {
      status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }

  const slug    = slugify(comp);
  const ip      = (req.headers.get("x-forwarded-for") || "anon").split(",")[0].trim();
  const rateKey = "ip-vote:" + ip + ":" + patch + ":" + slug + ":" + vote;

  // Rate-limit: one vote per direction per IP per patch
  try {
    const exists = await kvExists(rateKey);
    if (exists && exists.result) {
      return new Response(JSON.stringify({ ok: false, reason: "already_voted" }), {
        status: 429, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }
    await kvSetex(rateKey, 2592000, "1");  // TTL: 30 days
  } catch (err) {
    console.error("KV rate-limit check failed:", err.message);
    // Don't block the vote if KV is temporarily unavailable
  }

  // Increment vote counter and return updated score
  let upCount = 0, downCount = 0;
  try {
    const upKey   = "vote:" + patch + ":" + slug + ":up";
    const downKey = "vote:" + patch + ":" + slug + ":down";
    if (vote === "up") {
      const r = await kvIncr(upKey);
      upCount   = (r && r.result) ? r.result : 0;
      const d   = await kvGet(downKey);
      downCount = (d && d.result) ? d.result : 0;
    } else {
      const r = await kvIncr(downKey);
      downCount = (r && r.result) ? r.result : 0;
      const u   = await kvGet(upKey);
      upCount   = (u && u.result) ? u.result : 0;
    }
  } catch (err) {
    console.error("KV vote increment failed:", err.message);
    return new Response("Storage error", { status: 502 });
  }

  const score = upCount - downCount;
  return new Response(JSON.stringify({ ok: true, score, up: upCount, down: downCount }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
