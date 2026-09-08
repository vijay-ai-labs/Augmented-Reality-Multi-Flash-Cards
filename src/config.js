// Central asset config. For production, point ASSET_BASE at your CDN
// (e.g. Cloudflare R2 public bucket URL). Empty string = same origin (dev).
export const ASSET_BASE = '';

export const MANIFEST_URL = `${ASSET_BASE}/assets/manifest.json`;
export const PLACEMENTS_URL = `${ASSET_BASE}/assets/placements.json`;
export const targetUrl = (categoryId) => `${ASSET_BASE}/assets/targets/${categoryId}.mind`;
export const modelUrl = (card) => `${ASSET_BASE}/${card.model}`;
export const imageUrl = (card) => `${ASSET_BASE}/${card.image}`;
// Optional: cards whose deck has no matching clip in assets/audios/ have no
// `audio` field, and the AR view keeps its speaker button disabled for them.
export const audioUrl = (card) => (card.audio ? `${ASSET_BASE}/${card.audio}` : null);
