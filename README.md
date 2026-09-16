# TFT Set 18 — AP vs AD Guide

A single-page reference for **Teamfight Tactics Set 18: Enchanted Wilds**.  
Live at: [tft-guide.vercel.app](https://tft-guide.vercel.app) (or wherever you deploy it)

---

## What it covers

| Section | Description |
|---|---|
| **Rules** | How to tell at a glance if a champion scales with AP or AD |
| **Components** | All 8 base components with their stat and icon |
| **Items** | Completed items grouped by stat type (AP, AD, Both, Speed, Tank) with recipe tooltips |
| **Champions** | All 65 Set 18 champions sorted into AP / Adaptor / AD columns by cost tier, searchable |
| **Meta comps** | Curated comps from Mobalytics (meta + data + community), filterable by source, trait, role, and champion |
| **Trait shortcuts** | Quick-filter tiles linking traits to their item type |

---

## Files

```
tft-set18-ap-ad-chart.html   Single self-contained page (HTML + CSS + JS, no build step)
vercel.json                  Vercel routing config (clean URLs, security headers)
```

No build step, no dependencies, no bundler — open the file in any browser.

---

## Data sources (patch 18.2)

- **Champion stats & abilities** — in-game data, manually transcribed
- **Meta comps** — [Mobalytics meta comps](https://mobalytics.gg/tft/team-comps) (Challenger-curated)
- **Data comps** — [Mobalytics tier list](https://mobalytics.gg/tft/team-comps-tier-list) (Diamond+ match data)
- **Community comps** — [Mobalytics community comps](https://mobalytics.gg/tft/community-comps) (player-submitted, ≥2 votes)
- **Recommended items per champion** — each champion's Mobalytics page
- **Item art** — [cdn.mobalytics.gg](https://cdn.mobalytics.gg) (hotlinked; recipe icon shown as fallback on 404)
- **Champion portraits** — [tftraits.com](https://tftraits.com) (hotlinked; initials hex badge shown as fallback)

---

## Comp data structure

Each entry in `COMPS` has:

```js
{
  n:       "Comp Name",
  diff:    "Easy" | "Medium" | "Hard",
  style:   "Fast 8" | "Fast 9" | "Level 6 slow roll" | …,
  k:       "ap" | "ad" | "hy",          // colour key
  src:     "meta" | "stats" | "community",
  board:   ["Champion", …],             // 8–10 names, in board order
  alts:    ["Champion", …],             // interchangeable units
  carries: [["Champion", ["Item", …]]],  // carry + 3 recommended items
  when:    ["Condition to play this", …],
  tips:    ["Gameplay tip", …],
  slug:    "mobalytics-url-slug",        // "" for non-meta comps
  stats:   { place, top4, win, pick, as? }  // stats comps only
}
```

### Adding a new comp

1. Add an object to the `COMPS` array (or the relevant `.forEach` block for stats/community comps).
2. Make sure every champion name matches an entry in `CHAMPS` exactly.
3. Provide at least `board`, `carries`, `when`, and `tips` for meta comps so they show up fully in both the card view and the details overlay.

---

## Deployment

The project is deployed via [Vercel](https://vercel.com). `vercel.json` rewrites `/` to the HTML file with clean URLs and adds `X-Content-Type-Options` / `Referrer-Policy` headers.

To deploy your own copy:

```bash
npm i -g vercel
vercel
```

Or just drop the HTML file on any static host — no server-side logic required.
