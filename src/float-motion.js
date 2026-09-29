// "Comes out of the card and floats": the entrance and idle motion every card
// model gets in the AR view.
//
// attachFloat() inserts one group between the gesture group and the model
//
//   anchor.group -> placementGroup -> userTransformGroup -> floatGroup -> model
//                                  \-> shadow (on the card plane)
//
// so the motion never touches the placement pose, the user's own rotate/zoom,
// or the saved transform -- stopping it leaves the model exactly at rest.
//
// Pop: the model starts as a speck on the card plane and springs out toward
// the viewer with a small overshoot, while a soft shadow fades in on the card
// underneath it -- the printed picture peeling off the paper.
// Float: after that it hovers a little proud of the card, rising and sinking
// off it and swaying gently about its own up axis, forever. The shadow
// follows, softening as the model rises. Amplitudes scale with the model's
// height so a tiny flag and a full-card monument move alike.
//
// Time is stepped per rendered frame, not read off the wall clock, with each
// step capped. Two things depend on that:
//  - the first frames of a new model compile its shaders and upload its
//    textures, which stalls a phone for anything up to a second; timed by
//    the clock, the whole 750ms pop would be over before the first visible
//    frame and the model would simply appear;
//  - the caller only steps a card while it is tracked, so a card that drops
//    out and comes back resumes its bob where it left off instead of jumping
//    to wherever the clock says the sine wave has got to.
//
// DOM-free; three.js is the only dependency. Honors prefers-reduced-motion:
// the pop still lands (without overshoot) but there is no bob or sway.

import * as THREE from 'three';

// Measured on all 541 cards (tools/float-test.html): with 0.75s and a 1.4
// overshoot constant, the first pop frames moved deep models up to 16% of
// their size per frame at 60fps -- a lurch rather than a pop.
const POP_S = 0.9;
const BOB_PERIOD_S = 2.8;
const SWAY_PERIOD_S = 5.2;
const SWAY_RAD = THREE.MathUtils.degToRad(6);
// Longest step one frame may advance the motion. Anything slower than ~30fps
// is a stall, not a frame rate, and is played through rather than skipped.
const MAX_STEP_S = 1 / 30;

// Standard easeOutBack: overshoots ~5% then settles -- the "pop".
function easeOutBack(t) {
  const c1 = 1.2;
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

// One soft radial blob, shared by every card's shadow.
let shadowTexture = null;
function getShadowTexture() {
  if (shadowTexture) return shadowTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.75)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  shadowTexture = new THREE.CanvasTexture(canvas);
  shadowTexture.colorSpace = THREE.SRGBColorSpace;
  return shadowTexture;
}

/**
 * The motion itself, on an existing group. attachFloat() is the normal entry
 * point; this is exported for tests that want the bare curve.
 *
 * @param {THREE.Object3D} group  the float group; its local transform is owned here
 * @param {{ depth: number, height: number, reduced?: boolean }} dims
 *   depth  = how far the model's centre rests in front of the card (the
 *            buildModel pivot's z), so the pop can start on the card plane
 *   height = the model's resting height in card units, for amplitude scaling
 *   width  = its resting width; the sway swings the ends of a long model
 *            (alligator, train) back toward the card, and the hover must
 *            clear that or they dip through the card plane
 */
export function createFloatMotion(group, { depth = 0, height = 0.5, width = 0, reduced = prefersReducedMotion() } = {}) {
  const size = THREE.MathUtils.clamp(Number.isFinite(height) ? height : 0.5, 0.15, 1.2);
  const swayDip = reduced ? 0 : (Math.max(0, Number.isFinite(width) ? width : 0) / 2) * Math.sin(SWAY_RAD);
  const rise = reduced ? 0 : size * 0.04; // bob off the card
  // Rest this far proud of the card, toward the viewer: clear of the card at
  // the bottom of the bob and at full sway, with room to spare.
  const hover = size * 0.08 + rise + swayDip;
  const drift = reduced ? 0 : size * 0.015; // and a touch up the card
  const state = { elapsed: 0, e: 0, lift: 0 };

  function apply() {
    const t = Math.min(1, state.elapsed / POP_S);
    // easeOutBack alone leaves the card at full speed on frame one. Feeding it
    // smoothstep time eases the start too: the model gathers, whooshes out,
    // overshoots a little and settles, with no single frame lurching.
    const e = reduced ? smooth(t) : easeOutBack(smooth(t));
    const settle = smooth(t); // bob and sway fade in as the pop lands
    const bob = Math.sin((state.elapsed / BOB_PERIOD_S) * Math.PI * 2) * settle;
    // Never exactly zero: a zero scale makes the model's matrix singular and
    // raycasts against it (tap-to-replay) return NaN.
    group.scale.setScalar(Math.max(0.001, e));
    const lift = hover * e + rise * bob; // height of the model's centre above rest-on-card
    group.position.set(0, drift * bob, -depth * (1 - Math.min(e, 1)) + lift);
    group.rotation.set(0, reduced ? 0 : Math.sin((state.elapsed / SWAY_PERIOD_S) * Math.PI * 2) * SWAY_RAD * settle, 0);
    state.e = e;
    state.lift = lift;
  }

  apply();
  return {
    state,
    hover,
    /** Restart the entrance from the card plane. */
    pop() {
      state.elapsed = 0;
      apply();
    },
    /** Advance by one rendered frame of `dt` seconds (capped). */
    update(dt) {
      const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, MAX_STEP_S) : 0;
      state.elapsed += step;
      apply();
    }
  };
}

/**
 * Wire the float into a card's groups. Call with `root` still unparented, so
 * its box is measured in card units rather than through MindAR's anchor.
 *
 * @returns {{ pop(): void, update(dt: number): void, setShadowVisible(v: boolean): void,
 *             floatGroup: THREE.Group, shadow: THREE.Mesh, motion: object }}
 */
export function attachFloat({ placementGroup, userTransformGroup, root, pivot, reduced }) {
  root.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  const floatGroup = new THREE.Group();
  floatGroup.add(root);
  userTransformGroup.add(floatGroup);

  const depth = Number.isFinite(pivot?.z) ? pivot.z : 0;
  const motion = createFloatMotion(floatGroup, { depth, height: size.y, width: size.x, reduced });

  // The shadow lives on placementGroup, not under the gesture group: it must
  // stay flat on the card while the user tilts and spins the model. It
  // follows the gesture group's offset and zoom by hand in update().
  const w = Math.max(size.x, 0.05);
  const h = Math.max(size.y, 0.05);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: getShadowTexture(),
      color: 0x000000,
      transparent: true,
      opacity: 0,
      depthWrite: false
    })
  );
  shadow.renderOrder = -1; // under the model, whatever the sort says
  shadow.name = 'float-shadow';
  // Offset down-right: light from the upper left, like the app's own shadows.
  const dx = w * 0.04;
  const dy = -h * 0.05;
  placementGroup.add(shadow);
  let shadowOn = true;

  function place() {
    const { e, lift } = motion.state;
    const u = userTransformGroup;
    const zoom = u.scale.x;
    const grow = Math.max(0.001, Math.min(e, 1));
    // Higher = bigger, softer, fainter, as a real shadow does.
    const spread = 1 + lift * 0.6;
    shadow.position.set(u.position.x + dx * zoom, u.position.y + dy * zoom, -depth + 0.002);
    shadow.scale.set(w * 0.95 * zoom * grow * spread, h * 0.9 * zoom * grow * spread, 1);
    shadow.material.opacity = shadowOn ? 0.28 * grow / spread : 0;
    shadow.visible = shadowOn && grow > 0.01;
  }
  place();

  return {
    floatGroup,
    shadow,
    motion,
    pop() {
      motion.pop();
      place();
    },
    update(dt) {
      motion.update(dt);
      place();
    },
    /** Off while the model is pinned into the room: there is no card under it. */
    setShadowVisible(v) {
      shadowOn = v;
      place();
    },
    dispose() {
      placementGroup.remove(shadow);
      shadow.geometry.dispose();
      shadow.material.dispose();
    }
  };
}
