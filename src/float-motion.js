// "Comes out of the card and floats": the entrance and idle motion every card
// model gets in the AR view.
//
// Drives one extra group that sits between the gesture group and the model
// (anchor.group -> placementGroup -> userTransformGroup -> floatGroup -> model),
// so it never touches the placement pose, the user's own rotate/zoom, or the
// saved transform -- stopping it leaves the model exactly at rest.
//
// Pop: the model starts as a speck on the card plane and springs up to its
// resting pose with a small overshoot, finishing a little proud of the card.
// Float: after that it bobs up and down the card and sways gently about its
// own up axis, forever. Both amplitudes scale with the model's height so a
// tiny flag and a full-card monument move alike.
//
// DOM-free; three.js is the only dependency. Honors prefers-reduced-motion by
// skipping the bob and sway (the pop still lands, just without overshoot).

import * as THREE from 'three';

const POP_MS = 750;
const BOB_PERIOD_MS = 2800;
const SWAY_PERIOD_MS = 5200;
const SWAY_RAD = THREE.MathUtils.degToRad(6);

// Standard easeOutBack: overshoots ~10% then settles -- the "pop".
function easeOutBack(t) {
  const c1 = 1.4;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

const smooth = (t) => t * t * (3 - 2 * t);

function prefersReducedMotion() {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

/**
 * @param {THREE.Object3D} group  the float group; its local transform is owned here
 * @param {{ depth: number, height: number }} dims
 *   depth  = how far the model's centre rests in front of the card (the
 *            buildModel pivot's z), so the pop can start on the card plane
 *   height = the model's resting height in card units, for amplitude scaling
 */
export function createFloatMotion(group, { depth = 0, height = 0.5 } = {}) {
  const reduced = prefersReducedMotion();
  const size = THREE.MathUtils.clamp(height, 0.15, 1.2);
  const hover = size * 0.08; // rest this far proud of the card, toward the viewer
  const bob = reduced ? 0 : size * 0.035;
  let start = -Infinity;

  function update(now) {
    const t = Math.min(1, Math.max(0, (now - start) / POP_MS));
    const e = reduced ? smooth(t) : easeOutBack(t);
    // Never exactly zero: a zero scale makes the model's matrix singular and
    // raycasts against it (tap-to-replay) return NaN.
    group.scale.setScalar(Math.max(0.001, e));
    const since = now - start;
    const settle = smooth(t); // bob and sway fade in as the pop lands
    group.position.set(
      0,
      Math.sin((since / BOB_PERIOD_MS) * Math.PI * 2) * bob * settle,
      -depth * (1 - e) + hover * e
    );
    group.rotation.set(0, reduced ? 0 : Math.sin((since / SWAY_PERIOD_MS) * Math.PI * 2) * SWAY_RAD * settle, 0);
  }

  return {
    /** Restart the entrance from the card plane. */
    pop(now = performance.now()) {
      start = now;
      update(now);
    },
    update
  };
}
