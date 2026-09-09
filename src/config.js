// Central asset config. For production, point ASSET_BASE at your CDN
// (e.g. Cloudflare R2 public bucket URL). Empty string = same origin (dev).
//
// The value comes from VITE_ASSET_BASE, set in .env locally and in the host's
// environment settings for a deploy — see .env.example. Vite inlines it at
// BUILD time, not at runtime, so changing it on the host requires a rebuild;
// setting the variable alone does nothing to a deploy that already shipped.
//
// Unset means same origin, which is what dev and preview want: the dev server
// serves assets/ from the project root, and the preview middleware in
// vite.config.js does the same for a production build. Only a real deploy,
// where dist/ ships without the library, needs the CDN URL.
//
// The trailing slash is stripped because every helper below joins with an
// explicit "/" — without this, a base pasted as "https://cdn.example.com/"
// builds "https://cdn.example.com//assets/manifest.json". Most servers accept
// the doubled slash, R2 treats it as a different key and returns 404.
export const ASSET_BASE = (import.meta.env.VITE_ASSET_BASE ?? '').replace(/\/+$/, '');

export const MANIFEST_URL = `${ASSET_BASE}/assets/manifest.json`;
export const PLACEMENTS_URL = `${ASSET_BASE}/assets/placements.json`;
export const targetUrl = (categoryId) => `${ASSET_BASE}/assets/targets/${categoryId}.mind`;
export const modelUrl = (card) => `${ASSET_BASE}/${card.model}`;
export const imageUrl = (card) => `${ASSET_BASE}/${card.image}`;
// Optional: cards whose deck has no matching clip in assets/audios/ have no
// `audio` field, and the AR view keeps its speaker button disabled for them.
export const audioUrl = (card) => (card.audio ? `${ASSET_BASE}/${card.audio}` : null);
