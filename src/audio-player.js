// Per-card pronunciation playback.
//
// ONE shared HTMLAudioElement for the whole app, not one per card. 105 cards
// today and growing: an element per card would mean 105 live media elements,
// 105 preload fetches, and overlapping playback whenever two cards were
// discovered in quick succession. Instead the single element's `src` is
// swapped as the active card changes, and the browser's own HTTP cache makes
// re-scanning a card it already played effectively free.
//
// DOM-free apart from the Audio element itself, the same way placement-manager
// keeps to three.js: the AR view owns every button and status line.

// 8 samples of 16-bit silence. Played once from inside a real tap so iOS marks
// the element as user-activated; without it the first card's auto-play is
// always blocked, since entering a deck is the only tap that happens before a
// marker is found.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA';

function createPronunciationPlayer() {
  const audio = new Audio();
  audio.preload = 'auto';

  let currentPath = null;
  let unlocked = false;

  // Seeking an element that has loaded nothing is a no-op per spec, but guard
  // anyway: some engines throw InvalidStateError instead.
  function rewind() {
    try {
      audio.currentTime = 0;
    } catch {
      // Nothing decoded yet; playback will start from 0 regardless.
    }
  }

  function stop() {
    audio.pause();
    rewind();
  }

  // Rejection here is the expected path, not a fault: the browser blocks
  // autoplay until the page has seen a user gesture. The speaker button is
  // already enabled by the time this runs, so the user can simply tap it.
  // Deliberately silent -- no throw, no console noise, no toast.
  async function play() {
    try {
      await audio.play();
    } catch {
      // Autoplay blocked, or the clip was swapped out mid-play. Both fine.
    }
  }

  return {
    /** Make this card's clip the loaded one. Safe to call repeatedly. */
    load(path) {
      if (!path) {
        // A card with no clip. `audio.src` is deliberately left alone -- '' would
        // resolve to the document URL -- but currentPath must drop, or replay()
        // would still consider the previous card's word loaded.
        stop();
        currentPath = null;
        return;
      }
      // Reassigning the same src would tear down and refetch the media
      // element for no gain; replay() rewinds instead.
      if (path === currentPath) {
        stop();
        return;
      }
      stop(); // never let the previous card's word bleed into this one
      currentPath = path;
      audio.src = path;
    },

    /** Auto-play on discovery. Silently no-ops when autoplay is blocked. */
    play,

    /** The one restart-and-play path, shared by the speaker button and model taps. */
    replay() {
      if (!currentPath) return Promise.resolve();
      rewind();
      return play();
    },

    stop,

    /**
     * Call synchronously from inside a genuine tap (entering a deck), before
     * any await. Costs one silent 8-sample play and buys working auto-play on
     * iOS for the rest of the session.
     */
    unlock() {
      if (unlocked || currentPath) return;
      unlocked = true;
      audio.src = SILENT_WAV;
      audio.play().then(
        () => {
          // A card can be found before this promise settles (the tap starts the
          // camera). If a real clip took the element over in the meantime,
          // pausing here would silence the word instead of the silence.
          if (currentPath) return;
          audio.pause();
          rewind();
        },
        () => {
          // Still locked; the speaker button remains the fallback.
        }
      );
    }
  };
}

let player = null;

/** The app-wide single Audio element, created on first use. */
export function getPronunciationPlayer() {
  if (!player) player = createPronunciationPlayer();
  return player;
}
