// Small localStorage-backed key/value store for per-card view state.
//
// Two independent stores exist: the card-plane transforms the AR view writes,
// and the pinned size/heading pinned mode writes. They must not share a key --
// a model's pose on the card says nothing about how big it should stand in a
// room -- so the key is a constructor argument rather than a module constant.
//
// Every store degrades to memory-only when localStorage is unavailable
// (private mode, blocked cookies) or holds a corrupt payload, so a session
// still behaves; it just does not survive a reload.

export function createStore(storageKey) {
  let cache = null;

  function read() {
    if (cache) return cache;
    cache = {};
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') Object.assign(cache, parsed);
    } catch {
      // Blocked or corrupt: fall back to memory-only.
    }
    return cache;
  }

  return {
    // Returns a fresh object shaped like `defaults`, overlaid with any saved
    // finite numbers. Non-numeric and unknown saved fields are ignored, so an
    // older or hand-edited payload can never produce a broken state object.
    load(key, defaults) {
      const state = { ...defaults };
      const saved = read()[key];
      if (saved && typeof saved === 'object') {
        for (const field of Object.keys(state)) {
          if (Number.isFinite(saved[field])) state[field] = saved[field];
        }
      }
      return state;
    },

    save(key, state) {
      read()[key] = { ...state };
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(cache));
      } catch {
        // Keep the in-memory copy so the session still behaves.
      }
    }
  };
}
