/**
 * api/submit-comp.js — Vercel Edge Function
 *
 * POST /api/submit-comp
 * Body: { n, style, diff, board, when, tips, patch }
 *
 * Stores the submission in Vercel KV under:
 *   pending:<patch>:<slug>  →  JSON string
 *   pending:<patch>:<slug>:votes → integer (starts at 1 — submitter's implicit vote)
 *
 * Also supports upvoting an existing submission:
 *   POST /api/submit-comp  { vote: "<slug>", patch: "<patch>" }
 *
 * Environment variables required:
 *   KV_REST_API_URL
 *   KV_REST_API_TOKEN
 */

export const config = { runtime: "edge" };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MAX_NAME  = 80;
const MAX_UNITS = 12;

function kvUrl(p) { return process.env.KV_REST_API_URL + p; }

async function kvReq(method, p, body) {
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

async function kvSet(key, val)      { return kvReq("POST", "/set/" + key, val); }
async function kvIncr(key)          { return kvReq("POST", "/incr/" + key); }
async function kvGet(key)           { return kvReq("GET",  "/get/" + key); }
async function kvSetex(key, ttl, v) { return kvReq("POST", "/setex/" + key + "/" + ttl + "/" + v); }

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST")    return new Response("Method Not Allowed", { status: 405 });

  let body;
  try { body = await req.json(); }
  catch { return new Response("Bad Request", { status: 400 }); }

  // Graceful fallback if KV is not configured
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return new Response(JSON.stringify({ ok: true, note: "KV not configured" }), {
      status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }

  const ip = (req.headers.get("x-forwarded-for") || "anon").split(",")[0].trim();

  // ── upvote an existing submission ──────────────────────────────────────────
  if (body.vote && body.patch) {
    const slug     = slugify(body.vote);
    const voteKey  = "pending:" + body.patch + ":" + slug + ":votes";
    const ipKey    = "ip-pending-vote:" + ip + ":" + body.patch + ":" + slug;
    try {
      const alreadyVoted = await kvGet(ipKey);
      if (alreadyVoted && alreadyVoted.result) {
        return new Response(JSON.stringify({ ok: false, reason: "already_voted" }), {
          status: 429, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
      await kvSetex(ipKey, 2592000, "1");
      const r = await kvIncr(voteKey);
      return new Response(JSON.stringify({ ok: true, votes: (r && r.result) ? r.result : 0 }), {
        status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response("Storage error: " + err.message, { status: 502 });
    }
  }

  // ── new submission ─────────────────────────────────────────────────────────
  const { n, style, diff, board, when, tips, patch } = body;
  if (!n || !board || !patch) {
    return new Response("Missing required fields: n, board, patch", { status: 422 });
  }
  if (typeof n !== "string" || n.length > MAX_NAME) {
    return new Response("Comp name too long (max " + MAX_NAME + " chars)", { status: 422 });
  }
  if (!Array.isArray(board) || board.length < 4 || board.length > MAX_UNITS) {
    return new Response("Board must be an array of 4–" + MAX_UNITS + " champion names", { status: 422 });
  }

  // IP-rate-limit: one submission per IP per 24h
  const submitKey = "ip-submit:" + ip + ":" + patch;
  try {
    const recent = await kvGet(submitKey);
    if (recent && recent.result) {
      return new Response(JSON.stringify({ ok: false, reason: "rate_limited" }), {
        status: 429, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }
    await kvSetex(submitKey, 86400, "1"); // TTL: 24h
  } catch (err) {
    console.error("Rate-limit check failed:", err.message);
  }

  const slug    = slugify(n);
  const dataKey = "pending:" + patch + ":" + slug;
  const voteKey = dataKey + ":votes";

  const submission = {
    n, style: style || "", diff: diff || "",
    board: board.map(String).slice(0, MAX_UNITS),
    when:  Array.isArray(when) ? when.map(String).slice(0, 10) : [],
    tips:  Array.isArray(tips) ? tips.map(String).slice(0, 10) : [],
    patch, submittedAt: new Date().toISOString(),
    src: "community", k: "hy", slug: "", alts: [], carries: [],
  };

  try {
    await kvSet(dataKey, submission);
    const r = await kvIncr(voteKey); // start at 1 (submitter's implicit upvote)
    return new Response(JSON.stringify({ ok: true, votes: (r && r.result) ? r.result : 1 }), {
      status: 201, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response("Storage error: " + err.message, { status: 502 });
  }
}
