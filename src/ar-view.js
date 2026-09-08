import * as THREE from 'three';
import { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js';
import { audioUrl, targetUrl } from './config.js';
import { buildModel, loadPlacements, placementFor, placementOffset } from './placement.js';
import { createStore } from './transform-store.js';
import { cameraFailReason } from './camera-error.js';
import { PlacementManager } from './placement-manager.js';
import { getPronunciationPlayer } from './audio-player.js';

/* ---------------------------------------------------------------- transform */

const MIN_SCALE = 0.45;
const MAX_SCALE = 2.5;
const MAX_OFFSET = 0.75; // card units (card width == 1)
const YAW_PER_PX = 0.0075;
const TILT_PER_PX = 0.0075;
// v2: models now stand upright in the card plane instead of lying flat on it,
// so v1's saved yaw/tilt describe a frame that no longer exists.
const TRANSFORM_STORE_KEY = 'ar-flashcards.transforms.v2';

function createDefaultTransformState() {
  return { yaw: 0, tilt: 0, scale: 1, offsetX: 0, offsetY: 0 };
}

function wrapAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

// Tilt is a free pitch, wrapped the same as yaw (not hard-clamped) so
// vertical drag can spin the model all the way around, same as horizontal.
function clampTransform(state) {
  state.yaw = wrapAngle(state.yaw);
  state.tilt = wrapAngle(state.tilt);
  state.scale = THREE.MathUtils.clamp(state.scale, MIN_SCALE, MAX_SCALE);
  state.offsetX = THREE.MathUtils.clamp(state.offsetX, -MAX_OFFSET, MAX_OFFSET);
  state.offsetY = THREE.MathUtils.clamp(state.offsetY, -MAX_OFFSET, MAX_OFFSET);
  return state;
}

// Yaw spins about card +Y, which is the upright model's own up axis, so a
// horizontal drag reads as a turntable. (It used to spin about +Z, correct
// while models lay flat on the card; now +Z points at the camera and that same
// drag would cartwheel the model instead.) Euler order XYZ composes as
// Rx(tilt)*Ry(yaw): the turntable spin happens in the model's own frame first,
// then tilt tips the whole thing toward the viewer.
function applyTransform(group, state) {
  group.position.set(state.offsetX, state.offsetY, 0);
  group.rotation.set(state.tilt, state.yaw, 0);
  group.scale.setScalar(state.scale);
}

const transformStore = createStore(TRANSFORM_STORE_KEY);

function loadSavedTransform(categoryId, cardId) {
  return clampTransform(transformStore.load(`${categoryId}/${cardId}`, createDefaultTransformState()));
}

function saveTransform(categoryId, cardId, state) {
  transformStore.save(`${categoryId}/${cardId}`, state);
}

/* ----------------------------------------------------------------- gestures */

const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP_PX = 10;
const DRAG_START_PX = 3;

// No `idle` entry on purpose -- see refresh(): the pill hides instead.
const GESTURE_TEXT = {
  rotate: 'Turning',
  pinch: 'Zooming',
  move: 'Move Mode'
};

function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Pointer-Events gesture layer for the AR surface. Only ever writes to the
 * active target's userTransformGroup; MindAR keeps full control of anchor.group.
 * Returns a no-op controller when Pointer Events are unavailable.
 *
 * `onTap` fires only for a clean tap that actually landed on the model: one
 * finger down and up, no drag past the slop, no long press, no pinch anywhere
 * in the sequence, and a raycast hit on the model's own geometry.
 */
function createGestureController({ container, camera, statusEl, getActiveTarget, onCommit, onTap }) {
  const supported = typeof window.PointerEvent === 'function';
  if (!supported) {
    return { supported, refresh() {}, cancel() {}, destroy() {} };
  }
  const tap = onTap ?? (() => {});

  const pointers = new Map(); // pointerId -> { x, y }
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const dragPlane = new THREE.Plane();
  const planeNormal = new THREE.Vector3();
  const planePoint = new THREE.Vector3();
  const hitPoint = new THREE.Vector3();

  let mode = 'idle';
  let longPressTimer = 0;
  let startX = 0;
  let startY = 0;
  let pinchStartDistance = 0;
  let pinchStartScale = 1;
  let moveStart = null; // { localX, localY, offsetX, offsetY }
  let dirty = false;
  // Stays true only while the current pointer sequence could still be a tap.
  // Without it, lifting the second finger out of a pinch reads as a tap: the
  // survivor re-anchors startX/startY, so the final pointerup has zero travel.
  let tapCandidate = false;

  function setStatus(next) {
    if (mode === next) return;
    mode = next;
    refresh();
  }

  function refresh() {
    if (!statusEl) return;
    const target = getActiveTarget();
    // Idle says nothing: the gesture list is the help sheet's job now, and a
    // standing instruction pill just covers the model. The pill only speaks
    // while a gesture is actually running.
    const text = target ? GESTURE_TEXT[mode] : null;
    statusEl.hidden = !text;
    statusEl.dataset.mode = mode;
    if (text) statusEl.textContent = text;
  }

  function clearLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = 0;
    }
  }

  // Aims `raycaster` at a screen point. False when the container has no size
  // (mid-teardown, or a display: none ancestor), where NDC is meaningless.
  function aimRay(clientX, clientY) {
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    raycaster.setFromCamera(ndc, camera);
    return true;
  }

  // True when the point lands on the model's actual geometry, not just the
  // card plane around it -- tapping empty space beside the model does nothing.
  // userTransformGroup is the model's own subtree, so this works identically
  // for a card-anchored model and a placed one.
  function hitsModel(target, clientX, clientY) {
    if (!target.attached || !aimRay(clientX, clientY)) return false;
    target.userTransformGroup.updateWorldMatrix(true, true);
    return raycaster.intersectObject(target.userTransformGroup, true).length > 0;
  }

  // Screen point -> placementGroup-local point on the card plane.
  // Returns null when the ray grazes the plane; the caller just waits.
  function planePointFor(target, clientX, clientY) {
    if (!aimRay(clientX, clientY)) return null;

    const group = target.placementGroup;
    group.updateWorldMatrix(true, false);
    planeNormal.set(0, 0, 1).transformDirection(group.matrixWorld).normalize();
    planePoint.setFromMatrixPosition(group.matrixWorld);
    dragPlane.setFromNormalAndCoplanarPoint(planeNormal, planePoint);
    if (!raycaster.ray.intersectPlane(dragPlane, hitPoint)) return null;
    return group.worldToLocal(hitPoint);
  }

  function beginMove(target, clientX, clientY) {
    const local = planePointFor(target, clientX, clientY);
    moveStart = local
      ? { localX: local.x, localY: local.y, offsetX: target.state.offsetX, offsetY: target.state.offsetY }
      : null;
    setStatus('move');
  }

  function commit() {
    if (!dirty) return;
    dirty = false;
    const target = getActiveTarget();
    if (target) onCommit(target);
  }

  function onPointerDown(event) {
    const target = getActiveTarget();
    if (!target) return;
    if (pointers.size >= 2) return;

    try {
      container.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort; move/up still arrive on the container.
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 1) {
      startX = event.clientX;
      startY = event.clientY;
      tapCandidate = true;
      setStatus('idle');
      clearLongPress();
      longPressTimer = window.setTimeout(() => {
        longPressTimer = 0;
        const current = getActiveTarget();
        if (current && pointers.size === 1) {
          tapCandidate = false; // held long enough to be a move, not a tap
          beginMove(current, startX, startY);
        }
      }, LONG_PRESS_MS);
    } else {
      // Second finger: pinch wins, and it cancels any pending long press.
      clearLongPress();
      moveStart = null;
      tapCandidate = false;
      const [a, b] = [...pointers.values()];
      pinchStartDistance = distanceBetween(a, b) || 1;
      pinchStartScale = target.state.scale;
      setStatus('pinch');
    }
  }

  function onPointerMove(event) {
    const tracked = pointers.get(event.pointerId);
    if (!tracked) return;
    const target = getActiveTarget();
    if (!target) return;

    const previousX = tracked.x;
    const previousY = tracked.y;
    tracked.x = event.clientX;
    tracked.y = event.clientY;

    if (mode === 'pinch') {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const ratio = distanceBetween(a, b) / pinchStartDistance;
      target.state.scale = pinchStartScale * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1);
      clampTransform(target.state);
      applyTransform(target.userTransformGroup, target.state);
      dirty = true;
      return;
    }

    if (pointers.size !== 1) return;

    const travel = Math.hypot(event.clientX - startX, event.clientY - startY);
    if (longPressTimer && travel > LONG_PRESS_SLOP_PX) clearLongPress();
    if (travel > DRAG_START_PX) tapCandidate = false;

    if (mode === 'move') {
      if (!moveStart) {
        beginMove(target, event.clientX, event.clientY);
        return;
      }
      const local = planePointFor(target, event.clientX, event.clientY);
      if (!local) return;
      target.state.offsetX = moveStart.offsetX + (local.x - moveStart.localX);
      target.state.offsetY = moveStart.offsetY + (local.y - moveStart.localY);
    } else {
      if (mode === 'idle' && travel <= DRAG_START_PX) return;
      setStatus('rotate');
      target.state.yaw += (event.clientX - previousX) * YAW_PER_PX;
      target.state.tilt += (event.clientY - previousY) * TILT_PER_PX;
    }

    clampTransform(target.state);
    applyTransform(target.userTransformGroup, target.state);
    dirty = true;
  }

  function onPointerUp(event) {
    if (!pointers.delete(event.pointerId)) return;
    try {
      container.releasePointerCapture(event.pointerId);
    } catch {
      // Already released, e.g. after pointercancel.
    }
    const wasTap =
      tapCandidate &&
      event.type === 'pointerup' && // pointercancel/lostpointercapture are not taps
      pointers.size === 0 &&
      Math.hypot(event.clientX - startX, event.clientY - startY) <= DRAG_START_PX;
    tapCandidate = false;
    clearLongPress();
    moveStart = null;

    if (pointers.size === 1) {
      // A finger lifted out of a pinch: re-anchor so the survivor does not jump.
      const [remaining] = [...pointers.values()];
      startX = remaining.x;
      startY = remaining.y;
      setStatus('idle');
      return;
    }
    if (pointers.size === 0) {
      setStatus('idle');
      commit();
      const target = getActiveTarget();
      if (wasTap && target && hitsModel(target, event.clientX, event.clientY)) tap(target);
    }
  }

  // Drops everything in flight -- pointers, pending long press, move anchor --
  // and lands back on idle. Whatever the gesture had already applied to the
  // model IS committed: it is on screen and the user put it there, so losing it
  // on a target-lost or a Place Here tap would read as the model snapping back.
  function cancel() {
    clearLongPress();
    for (const pointerId of pointers.keys()) {
      try {
        container.releasePointerCapture(pointerId);
      } catch {
        // Pointer already gone.
      }
    }
    pointers.clear();
    moveStart = null;
    tapCandidate = false;
    commit();
    setStatus('idle');
    refresh();
  }

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerUp);
  container.addEventListener('pointercancel', onPointerUp);
  container.addEventListener('lostpointercapture', onPointerUp);

  return {
    supported,
    refresh,
    cancel,
    destroy() {
      clearLongPress();
      pointers.clear();
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerUp);
      container.removeEventListener('lostpointercapture', onPointerUp);
    }
  };
}

/* --------------------------------------------------------------------- help */

// Gesture rows, in the order a child meets them: look, then touch, then park.
// Emoji carry the meaning -- the audience mostly cannot read the labels.
const HELP_TOUCH_ITEMS = [
  { icon: '👆', title: 'Drag to turn', body: 'Slide one finger to spin the model around.' },
  { icon: '🤏', title: 'Pinch to zoom', body: 'Two fingers apart to grow, together to shrink.' },
  { icon: '✋', title: 'Hold to move', body: 'Press and hold, then drag to slide it about.' },
  { icon: '👇', title: 'Tap to hear', body: 'Tap the model to say the word again.' }
];

const HELP_BUTTON_ITEMS = [
  { icon: '🔊', title: 'Speaker', body: 'Bottom left -- says the word again.' },
  { icon: '📌', title: 'Place Here', body: 'Bottom middle -- leaves the model in the room.' },
  { icon: '↺', title: 'Reset', body: 'Bottom right -- puts the model back how it started.' }
];

function buildHelpList(items) {
  const list = document.createElement('ul');
  list.className = 'ar-help-list';
  for (const item of items) {
    const row = document.createElement('li');
    row.className = 'ar-help-row';

    const icon = document.createElement('span');
    icon.className = 'ar-help-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = item.icon;

    const text = document.createElement('span');
    text.className = 'ar-help-text';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const body = document.createElement('span');
    body.textContent = item.body;
    text.append(title, body);

    row.append(icon, text);
    list.append(row);
  }
  return list;
}

/**
 * The top-right "?" and the sheet it opens. Self-contained: nothing in the AR
 * session reads its state, so it only has to clean up after itself on stop().
 * Touch rows are dropped when Pointer Events are missing, since those gestures
 * genuinely do nothing there (see createGestureController).
 */
function createHelpControls() {
  const helpBtn = document.createElement('button');
  helpBtn.type = 'button';
  helpBtn.className = 'ar-help-btn';
  helpBtn.textContent = '?';
  helpBtn.setAttribute('aria-label', 'How to play');
  helpBtn.setAttribute('aria-expanded', 'false');

  const helpSheet = document.createElement('div');
  helpSheet.className = 'ar-help-sheet';
  helpSheet.setAttribute('role', 'dialog');
  helpSheet.setAttribute('aria-modal', 'false');
  helpSheet.setAttribute('aria-label', 'How to play');
  helpSheet.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'ar-help-panel';

  const heading = document.createElement('h2');
  heading.className = 'ar-help-title';
  heading.textContent = 'How to play';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ar-help-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close');

  panel.append(heading, closeBtn);
  if (typeof window.PointerEvent === 'function') panel.append(buildHelpList(HELP_TOUCH_ITEMS));
  panel.append(buildHelpList(HELP_BUTTON_ITEMS));
  helpSheet.append(panel);

  function setOpen(open) {
    helpSheet.hidden = !open;
    helpBtn.setAttribute('aria-expanded', String(open));
    if (open) closeBtn.focus();
    else helpBtn.focus();
  }

  function onToggle() {
    setOpen(helpSheet.hidden);
  }

  function onClose() {
    setOpen(false);
  }

  // Taps land on the backdrop only; the panel stops its own so a tap inside
  // (scrolling the list, say) never closes the sheet.
  function onBackdrop(event) {
    if (event.target === helpSheet) setOpen(false);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && !helpSheet.hidden) {
      event.stopPropagation();
      setOpen(false);
    }
  }

  helpBtn.addEventListener('click', onToggle);
  closeBtn.addEventListener('click', onClose);
  helpSheet.addEventListener('click', onBackdrop);
  document.addEventListener('keydown', onKeyDown);

  return {
    helpBtn,
    helpSheet,
    destroyHelp() {
      helpBtn.removeEventListener('click', onToggle);
      closeBtn.removeEventListener('click', onClose);
      helpSheet.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKeyDown);
    }
  };
}

/* ------------------------------------------------------------------ startAR */

export async function startAR(screenEl, category) {
  if (!window.isSecureContext) {
    throw new Error('Camera is blocked on insecure pages. Open the HTTPS address from npm run dev, or use localhost.');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot access the camera.');
  }

  const placements = await loadPlacements();
  const container = document.createElement('div');
  container.id = 'ar-container';

  const hint = document.createElement('div');
  hint.className = 'scan-hint';
  hint.setAttribute('role', 'status');
  hint.setAttribute('aria-live', 'polite');
  hint.textContent = 'Point at one card';

  const gesturePill = document.createElement('div');
  gesturePill.className = 'gesture-pill';
  gesturePill.setAttribute('role', 'status');
  gesturePill.setAttribute('aria-live', 'polite');
  gesturePill.hidden = true;

  // Not a play/pause toggle: it means "a word is loaded, tap to hear it again".
  // Disabled state tracks whether a card is active, never whether the clip
  // happens to be playing right now.
  const audioBtn = document.createElement('button');
  audioBtn.type = 'button';
  audioBtn.className = 'ar-audio-btn';
  audioBtn.textContent = '🔊';
  audioBtn.setAttribute('aria-label', 'Say the word again');
  audioBtn.disabled = true;

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'ar-reset-btn';
  resetBtn.textContent = 'Reset';
  resetBtn.setAttribute('aria-label', 'Reset the model rotation, size and position');
  resetBtn.disabled = true;

  // WIRE-UP POINT 1 -- the two placement buttons. Swap these for your own
  // elements if you are lifting this into another app; nothing below cares
  // where they came from, only that exactly one of the pair is visible.
  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.className = 'ar-pin-btn';
  pinBtn.textContent = 'Place Here';
  pinBtn.setAttribute('aria-label', 'Leave this model in the room');
  pinBtn.hidden = true;

  const unpinBtn = document.createElement('button');
  unpinBtn.type = 'button';
  unpinBtn.className = 'ar-pin-btn ar-unpin-btn';
  unpinBtn.textContent = 'Return to Card';
  unpinBtn.setAttribute('aria-label', 'Put the model back on its card');
  unpinBtn.hidden = true;

  const { helpBtn, helpSheet, destroyHelp } = createHelpControls();

  const gesturesSupported = typeof window.PointerEvent === 'function';

  // Top-centre column. Everything transient lives inside it and is laid out in
  // flow, so a hidden pill leaves no gap behind -- which fixed offsets could
  // not do once the idle gesture pill stopped rendering.
  const topStack = document.createElement('div');
  topStack.className = 'ar-top-stack';
  topStack.append(hint);
  if (gesturesSupported) topStack.append(gesturePill);

  // The speaker button ships either way: without Pointer Events there is no
  // tap-the-model replay, which makes the button the only way to hear it again.
  const overlayNodes = [topStack, helpBtn, helpSheet, audioBtn, pinBtn, unpinBtn];
  if (gesturesSupported) overlayNodes.push(resetBtn);
  screenEl.replaceChildren(container, ...overlayNodes);

  const mindarThree = new MindARThree({
    container,
    imageTargetSrc: targetUrl(category.id),
    filterMinCF: 0.0001,
    filterBeta: 0.001,
    missTolerance: 5,
    warmupTolerance: 2,
    uiLoading: 'no',
    uiScanning: 'no',
    uiError: 'no'
  });

  const { renderer, scene, camera } = mindarThree;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(0.5, 1, 1);
  scene.add(dir);

  const mixers = new Map(); // anchor index -> THREE.AnimationMixer
  const tempNodes = new Set(); // transient overlay elements to clean up on stop
  const clock = new THREE.Clock();
  let activeTarget = null;
  let stopped = false;

  // One manager, one placed model at a time -- this is single-model placement
  // by design. Supporting several pinned models at once would need one manager
  // per model, not this shared instance, plus per-model reference quaternions.
  const placementManager = new PlacementManager();
  let placedTarget = null;

  // A placed model stays gesture-controllable even with no marker in view --
  // that is the point of placing it. Everything that acts on "the model the
  // user is working with" goes through here rather than activeTarget directly.
  const controllableTarget = () => activeTarget ?? placedTarget;

  /* -------------------------------------------------------------- audio */

  // One shared Audio element for the whole app; see src/audio-player.js.
  const audioPlayer = getPronunciationPlayer();

  // The single restart-and-play path. Both replay triggers -- the speaker
  // button and a tap on the model itself -- go through here so they can never
  // drift apart.
  function replayActiveAudio() {
    const target = controllableTarget();
    if (!target?.audioPath) return;
    audioPlayer.load(target.audioPath); // no-op when it is already the loaded clip
    audioPlayer.replay();
  }

  // A card became active: swap in its clip and try to play it once. The play
  // is allowed to fail silently (autoplay policy) -- the button is already
  // enabled by then, so the word is never more than one tap away.
  function activateAudio(target) {
    audioPlayer.load(target?.audioPath ?? null);
    refreshPlacementUI(); // enables the button before the play attempt
    if (target?.audioPath) audioPlayer.play();
  }

  // No card active any more: silence it and let refreshPlacementUI grey the
  // button out, so it can never be tapped with nothing loaded.
  function deactivateAudio() {
    audioPlayer.stop();
  }

  const gestures = createGestureController({
    container,
    camera,
    statusEl: gesturePill,
    getActiveTarget: controllableTarget,
    onCommit: (target) => saveTransform(target.categoryId, target.cardId, target.state),
    onTap: () => {
      replayActiveAudio();
      navigator.vibrate?.(10);
    }
  });

  function refreshPlacementUI() {
    const placed = placementManager.isPlaced;
    unpinBtn.hidden = !placed;
    // Offered only once the model is actually on screen: pinning a card whose
    // .glb is still downloading would leave an empty group in the room.
    pinBtn.hidden = placed || !activeTarget?.attached;
    const controllable = controllableTarget();
    resetBtn.disabled = !controllable;
    audioBtn.disabled = !controllable?.audioPath;
  }

  function onAudioClick() {
    replayActiveAudio();
  }
  audioBtn.addEventListener('click', onAudioClick);

  function setActiveTarget(target) {
    // Every change of active card silences the outgoing one, even the paths
    // that do not go on to start a new clip -- a second card entering view
    // while its model still downloads would otherwise leave the first card
    // talking over it. Re-selecting the same target is left alone so a replay
    // in progress is not cut off.
    if (target !== activeTarget) audioPlayer.stop();
    activeTarget = target;
    refreshPlacementUI();
    gestures.refresh();
  }

  // Everything that happens when a card becomes the one on screen: announce it,
  // make it the gesture/audio subject, and make sure its model is built. Shared
  // by onTargetFound and the unpin path, which has to be able to adopt a card
  // MindAR will not announce again (see onUnpinClick).
  function focusTarget(target) {
    hint.textContent = `${target.card.name ?? target.cardId} found`;
    setActiveTarget(target);
    // Auto-play fires at whichever comes first: right here when the model is
    // already built (every sighting after the first, since the GLTF is cached),
    // or at the end of target.load() on a first sighting, so the word lands
    // with the model instead of over an empty screen.
    if (target.attached) activateAudio(target);
    target.load();
  }

  // The whole per-card subtree is what gets pinned, not the bare model: it
  // carries the card's placement offset and the user's own rotate/zoom, so
  // gestures keep working on a placed model and the return to the card lands
  // it exactly where it was.
  const rootOf = (target) => target.placementGroup;

  async function onPinClick() {
    const target = activeTarget;
    // target.visible matters as much as attached: MindAR parks an untracked
    // anchor on a degenerate matrix, and placing from one used to leave the
    // model at zero scale with a NaN rotation -- gone until Return to Card.
    if (!target?.attached || !target.visible || placementManager.isPlaced) return;
    gestures.cancel();
    pinBtn.disabled = true;

    // Called straight from the tap: iOS only grants motion access from a
    // genuine user gesture, so nothing slow may run before this.
    const result = await placementManager.requestPermissionAndPlace(rootOf(target), scene, target.anchorGroup);

    // The permission dialog can outlast the whole session -- the user is free
    // to hit Back while it is up. stop() has already torn everything down by
    // then, so undo the placement it could not know about.
    if (stopped) {
      if (result === 'ok') placementManager.release(rootOf(target), scene, target.anchorGroup);
      return;
    }

    pinBtn.disabled = false;
    if (result !== 'ok') {
      // Nothing was reparented. Put the UI back exactly as it was.
      refreshPlacementUI();
      hint.textContent =
        result === 'denied'
          ? 'Motion access denied, so the model cannot be placed.'
          : 'Lost the card before it could be placed. Point at the card and try again.';
      return;
    }

    placedTarget = target;
    refreshPlacementUI();
    gestures.refresh();
    const name = target.card.name ?? target.cardId;
    hint.textContent = `${name} placed. Turn your phone to look around.`;
    navigator.vibrate?.([12, 40, 12]);

    // The sensor usually needs a moment for its first reading and on some
    // phones never reports at all. Placement no longer waits on it, so the
    // "no motion data" line is only earned once that is actually settled --
    // and only if this same placement is still the one on screen.
    placementManager.whenOrientationReady(2000).then((ready) => {
      if (ready || stopped || placedTarget !== target) return;
      hint.textContent = `${name} placed, but this phone reports no motion data.`;
    });
  }
  pinBtn.addEventListener('click', onPinClick);

  function onUnpinClick() {
    if (!placementManager.isPlaced || !placedTarget) return;
    gestures.cancel();
    const target = placedTarget;
    placementManager.release(rootOf(target), scene, target.anchorGroup);
    placedTarget = null;

    // Whatever card is actually in front of the camera takes over, and it need
    // not be the one that was placed: a different card sighted during the
    // placement was deliberately ignored back then, and MindAR only fires
    // onTargetFound on a found/lost edge, so it will never announce that card
    // again while it stays in view. Without this it sits there dead -- no
    // model, no Place Here button -- until the user looks away and back.
    const resumed = target.visible ? target : (targets.find((t) => t.visible) ?? null);

    if (!resumed) {
      // With the card gone the model goes with it, so this is the moment the
      // card stops being active for audio too.
      deactivateAudio();
      setActiveTarget(null);
      hint.textContent = 'Point at one card';
    } else if (resumed === target) {
      // Back on its own card, still in view: nothing to load, and no reason to
      // repeat the word the user just heard.
      setActiveTarget(target);
      hint.textContent = `${target.card.name ?? target.cardId} found`;
    } else {
      focusTarget(resumed);
    }
    navigator.vibrate?.(12);
  }
  unpinBtn.addEventListener('click', onUnpinClick);

  function onResetClick() {
    const target = controllableTarget();
    if (!target) return;
    gestures.cancel();
    Object.assign(target.state, createDefaultTransformState());
    applyTransform(target.userTransformGroup, target.state);
    saveTransform(target.categoryId, target.cardId, target.state);
  }
  resetBtn.addEventListener('click', onResetClick);

  // Every card's target, in manifest order. onUnpinClick scans it for whichever
  // marker is in view at that moment.
  const targets = [];

  category.cards.forEach((card, index) => {
    const anchor = mindarThree.addAnchor(index);
    const placement = placementFor(placements, category.id, card.id);

    // anchor.group (MindAR) -> placementGroup (static) -> userTransformGroup (gestures) -> model
    const offset = placementOffset(card, placement);
    const placementGroup = new THREE.Group();
    placementGroup.position.set(offset.x, offset.y, 0);
    const userTransformGroup = new THREE.Group();
    placementGroup.add(userTransformGroup);
    anchor.group.add(placementGroup);

    const state = loadSavedTransform(category.id, card.id);
    applyTransform(userTransformGroup, state);

    const target = {
      categoryId: category.id,
      cardId: card.id,
      card,
      // WIRE-UP POINT 2 -- each trackable model keeps its own marker anchor
      // group. PlacementManager needs it to reparent out of and back into.
      anchorGroup: anchor.group,
      placementGroup,
      userTransformGroup,
      // Resolved once here rather than per play. Null for cards with no clip,
      // which is what keeps the speaker button disabled for them.
      audioPath: audioUrl(card),
      state,
      attached: false,
      visible: false, // is this marker currently being tracked?
      // Builds the model on demand; see loadModel below.
      load: null
    };
    targets.push(target);

    let loading = false;

    // Build this card's model, once. Deliberately not inlined into
    // onTargetFound: the unpin path needs to run it too, for a card that came
    // into view while something was placed and so never got a found event of
    // its own.
    async function loadModel() {
      if (stopped || target.attached || loading) return;
      loading = true;

      const loadingBadge = document.createElement('div');
      loadingBadge.className = 'model-loading';
      loadingBadge.setAttribute('role', 'status');
      loadingBadge.textContent = 'Loading model...';
      topStack.appendChild(loadingBadge); // in flow, straight under the hint

      tempNodes.add(loadingBadge);

      try {
        const { root, modelScene, animations, pivot } = await buildModel(card, placement);
        if (stopped) return;
        placementGroup.position.set(offset.x + pivot.x, offset.y + pivot.y, pivot.z);
        userTransformGroup.add(root);
        if (animations?.length) {
          const mixer = new THREE.AnimationMixer(modelScene);
          mixer.clipAction(animations[0]).play();
          mixers.set(index, mixer);
        }
        target.attached = true;
        // Only if the card is still the one in view: the user may well have
        // moved on during the download, and a stale word would talk over it.
        if (activeTarget === target) activateAudio(target);
      } catch {
        hint.textContent = `Model failed to load for ${card.name ?? card.id}`;
      } finally {
        loading = false;
        loadingBadge.remove();
        tempNodes.delete(loadingBadge);
      }
    }
    target.load = loadModel;

    anchor.onTargetFound = () => {
      if (stopped) return;
      target.visible = true;

      // While something is placed, a marker coming into view must not steal
      // focus or disturb the placement. The placed card's own marker returning
      // is worth a status line, and nothing more. Note that a DIFFERENT card
      // seen here is left unloaded on purpose -- onUnpinClick picks it up.
      if (placementManager.isPlaced) {
        if (placedTarget === target) {
          hint.textContent = `${card.name ?? card.id} is placed in the room.`;
        }
        return;
      }

      focusTarget(target);
    };

    anchor.onTargetLost = () => {
      target.visible = false;

      // Losing the marker normally means the content goes away. Not while
      // something is placed -- persisting without the marker in view is the
      // entire point, so leave the placed model and the UI alone.
      if (placementManager.isPlaced) return;

      hint.textContent = 'Point at one card';
      if (activeTarget !== target) return;
      // Keep target.state in memory so the model returns exactly as the user left it.
      gestures.cancel();
      deactivateAudio();
      setActiveTarget(null); // refreshes the UI, greying out the speaker button
    };
  });

  try {
    await mindarThree.start();
  } catch (err) {
    gestures.destroy();
    audioBtn.removeEventListener('click', onAudioClick);
    resetBtn.removeEventListener('click', onResetClick);
    pinBtn.removeEventListener('click', onPinClick);
    unpinBtn.removeEventListener('click', onUnpinClick);
    destroyHelp();
    placementManager.dispose();
    // MindARThree built a renderer before start() failed. Denying the camera,
    // going Back and retrying is the normal user loop here, and each failed
    // attempt would otherwise strand a live WebGL context until the browser
    // hits its cap and starts killing them.
    try {
      mindarThree.stop();
    } catch {
      // Nothing was started; only the renderer needs releasing.
    } finally {
      renderer.dispose();
    }
    container.remove();
    overlayNodes.forEach((node) => node.remove());
    throw new Error(await cameraFailReason(err));
  }

  renderer.setAnimationLoop(() => {
    const delta = clock.getDelta();
    for (const mixer of mixers.values()) mixer.update(delta);
    // WIRE-UP POINT 3 -- after per-model animation, before rendering. Only the
    // one placed model is compensated, and only while it is placed.
    if (placementManager.isPlaced && placedTarget) placementManager.update(rootOf(placedTarget));
    renderer.render(scene, camera);
  });

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      gestures.cancel();
      gestures.destroy();
      // The Audio element outlives this session (it is app-wide), so leaving a
      // deck must silence it or the last word follows the user back home.
      audioPlayer.stop();
      audioBtn.removeEventListener('click', onAudioClick);
      resetBtn.removeEventListener('click', onResetClick);
      pinBtn.removeEventListener('click', onPinClick);
      unpinBtn.removeEventListener('click', onUnpinClick);
      // The Escape handler lives on document, so it outlives this screen unless
      // it is torn down here.
      destroyHelp();
      // Hand the model back to its anchor before tearing down, so a model left
      // placed does not come back mid-air on the next visit to this deck.
      if (placementManager.isPlaced && placedTarget) {
        placementManager.release(rootOf(placedTarget), scene, placedTarget.anchorGroup);
      }
      placementManager.dispose();
      placedTarget = null;
      renderer.setAnimationLoop(null);
      for (const mixer of mixers.values()) mixer.stopAllAction();
      mixers.clear();
      activeTarget = null;
      try {
        mindarThree.stop();
      } finally {
        renderer.dispose();
      }
      // Geometries and materials are shared with the cached GLTF, so they are
      // deliberately not disposed here; only per-session DOM is torn down.
      tempNodes.forEach((node) => node.remove());
      tempNodes.clear();
      container.remove();
      overlayNodes.forEach((node) => node.remove());
    }
  };
}
