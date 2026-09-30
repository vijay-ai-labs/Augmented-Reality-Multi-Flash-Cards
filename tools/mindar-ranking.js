// The rule that picks which card a camera frame shows, given every target's
// inlier count. Single source for tools/patch-mindar.mjs (which splices it
// into MindAR's matcher worker) and tools/check-recognition.mjs (which
// measures it), so what gets tested is what ships.
//
// Stock MindAR takes the FIRST target in manifest order with >= 6 inliers.
// On template decks (months, clocks, jerseys) the shared layout alone clears
// 6 on every card, so the earliest card wins whatever is in front of the
// camera. Ranking takes the best instead, and declines to answer when the best
// is not clearly ahead -- a skipped frame costs ~30ms, a wrong model costs the
// child the lesson. The next frame (a different crop) usually settles it.

export const RANK_MIN_INLIERS = 10;
export const RANK_MARGIN = 1.3;

// Index of the winning target, or -1 for "not sure yet".
export function pickRanked(scores) {
  let best = -1;
  let bestScore = 0;
  let second = 0;
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (s > bestScore) {
      second = bestScore;
      bestScore = s;
      best = i;
    } else if (s > second) {
      second = s;
    }
  }
  if (best === -1 || bestScore < RANK_MIN_INLIERS) return -1;
  if (second > 0 && bestScore < second * RANK_MARGIN) return -1;
  return best;
}
