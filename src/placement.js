// Card placement math, shared by the AR runtime (src/ar-view.js) and the
// placement editor (tools/place-models.html).
//
// Both must agree exactly: the editor is only useful if what it draws is what
// the AR view will show, and normalizeModel() below encodes several non-obvious
// fixes that were found against real assets. Keep this the single copy.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { PLACEMENTS_URL, modelUrl } from './config.js';

// Every model in the library is Draco-compressed (tools/compress-models.mjs
// runs `--compress draco`), so the decoder is not optional -- without it every
// card fails to load. It is served from public/draco/, which is three r160's
// own glTF decoder build, rather than from gstatic: a CDN fetch adds a
// third-party dependency to the one file the whole app cannot work without, and
// it fails outright offline or on a LAN-only phone test.
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('/draco/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

// card.model path -> Promise<GLTF>. Only the source GLTF is shared; every anchor
// gets its own cloned scene so user gestures never leak between cards/sessions.
const gltfCache = new Map();

export const DEFAULT_CARD_ASPECT = 1.4167;

export async function loadPlacements() {
  try {
    const res = await fetch(PLACEMENTS_URL);
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

// Exact card entry wins; the per-deck "<category>/*" entry is the fallback.
// Decks whose cards share one printed template (animals, bikes, birds,
// continents, planets) only need the wildcard; alphabets keeps 26 exact
// entries and defines no wildcard, so it is unaffected.
export function placementFor(placements, categoryId, cardId) {
  return placements?.[`${categoryId}/${cardId}`] ?? placements?.[`${categoryId}/*`];
}

export function cardAspectOf(card) {
  return card.w && card.h ? card.h / card.w : DEFAULT_CARD_ASPECT;
}

/* -------------------------------------------------------------- orientation */

// Models stand upright IN the card plane -- up along card +Y, front toward the
// camera -- so that a card viewed head-on shows the same view as its printed
// art. (The old pose laid them flat with up along the card normal, which shows
// the model's top and can never match the print.)
//
// Source glTFs have no usable convention: inspected across all six decks, root
// nodes carry arbitrary matrices, local extents run from 0.026 to 2954, and the
// longest local axis is x, y or z depending on the file. Orientation is per-card
// data, solved against the printed silhouette by tools/orient-solver.js.
//
// `up` names the model-local axis that should point up; heading/pitch/roll are
// degrees applied after that, heading being the turntable spin the solver
// searches hardest.
const UP_AXES = {
  '+x': new THREE.Vector3(1, 0, 0),
  '-x': new THREE.Vector3(-1, 0, 0),
  '+y': new THREE.Vector3(0, 1, 0),
  '-y': new THREE.Vector3(0, -1, 0),
  '+z': new THREE.Vector3(0, 0, 1),
  '-z': new THREE.Vector3(0, 0, -1)
};

export const UP_AXIS_KEYS = Object.keys(UP_AXES);
export const DEFAULT_ORIENT = { up: '+y', heading: 0, pitch: 0, roll: 0 };

// Legacy `yaw` entries (the 26 hand-tuned alphabets cards) are headings as-is.
// The old net rotation was Rz(yaw)*Rx(90deg); standing that upright is a
// left-multiply by Rx(-90deg), and conjugation carries the axis with it:
//   Rx(-90)*Rz(yaw)*Rx(90) = R(Rx(-90)*z, yaw) = R(y, yaw) = Ry(yaw)
// so the upright pose is a plain heading about the model's own up axis and the
// tuned numbers transfer unchanged.
export function orientOf(placement) {
  const raw = placement?.orient;
  if (raw && typeof raw === 'object') {
    return {
      up: UP_AXES[raw.up] ? raw.up : DEFAULT_ORIENT.up,
      heading: Number.isFinite(raw.heading) ? raw.heading : 0,
      pitch: Number.isFinite(raw.pitch) ? raw.pitch : 0,
      roll: Number.isFinite(raw.roll) ? raw.roll : 0
    };
  }
  return { ...DEFAULT_ORIENT, heading: Number.isFinite(placement?.yaw) ? placement.yaw : 0 };
}

const _qUp = new THREE.Quaternion();
const _euler = new THREE.Euler();

// q = Ry(heading) * Rx(pitch) * Rz(roll) * qUp.
// YXZ order puts roll innermost (it corrects models whose up axis needed a
// sideways twist) and heading outermost (it spins the already-upright model).
export function orientationQuaternion(orient, out = new THREE.Quaternion()) {
  const o = orient ?? DEFAULT_ORIENT;
  const axis = UP_AXES[o.up] ?? UP_AXES['+y'];
  _qUp.setFromUnitVectors(axis, UP_AXES['+y']);
  _euler.set(
    THREE.MathUtils.degToRad(o.pitch ?? 0),
    THREE.MathUtils.degToRad(o.heading ?? 0),
    THREE.MathUtils.degToRad(o.roll ?? 0),
    'YXZ'
  );
  return out.setFromEuler(_euler).multiply(_qUp);
}

// Static half of placements.json: where on the card the model sits.
// Lives on placementGroup so user offsets stay in plain card units.
export function placementOffset(card, placement) {
  if (!placement?.box) return { x: 0, y: 0 };
  const [x = 0.1, y = 0.1, w = 0.8, h = 0.8] = placement.box;
  const cardAspect = cardAspectOf(card);
  return { x: x + w / 2 - 0.5, y: (0.5 - (y + h / 2)) * cardAspect };
}

// Scale to the placement box, centre on x/y, sit the model in front of the card.
//
// Rotation is applied FIRST, before any measuring. Object3D composes as
// T*R*S, so a translation computed from the box while unrotated does not
// stay centered once the orientation is set afterward: the post-rotation
// centroid becomes (R-I)*preRotationCenter, which is huge whenever the raw
// glTF geometry isn't already centered at its own local origin (verified on
// real assets with placement.yaw set: this pushed the model 5-6 units off the
// card, outside the camera frustum -- invisible with no error). Rotating
// first means every later box measurement already reflects the final
// orientation, so centering it stays correct.
//
// Box3 uses non-precise mode deliberately (default: each mesh's cached
// geometry.boundingBox transformed by matrixWorld) rather than `precise:
// true`. Precise mode calls getVertexPosition() per vertex, which for a
// SkinnedMesh applies live skinning via bone matrices -- verified on a
// skinned asset (rigged in its source file, never animated here) that those
// bone matrices aren't valid at this point (no render/pose has run yet),
// inflating the measured box ~80x, matching a discarded ancestor scale
// exactly. computeBoundingBox()/computeBoundingSphere() are forced fresh on
// every mesh instead, since GLTFLoader's own cached box can't be trusted
// blindly either. The explicit updateMatrixWorld() is required too: setting
// root.scale doesn't synchronously refresh descendants' matrixWorld, which
// the second measuring pass reads.
//
// Once oriented, the measured box maps straight onto what the camera sees:
// size.x is width across the card, size.y is height up the card, size.z is
// depth toward the viewer. Only x and y are the printed picture's footprint,
// so only they may drive the scale -- the old code capped by max(x, y, z),
// letting an unseen depth shrink the model, and measured "height" on an axis
// that was really depth.
export function normalizeModel(root, card, placement) {
  orientationQuaternion(orientOf(placement), root.quaternion);

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const cardAspect = cardAspectOf(card);
  const [, , w = 0.8, h = 0.8] = placement?.box ?? [];
  const targetWidth = w;
  const targetHeight = h * cardAspect;
  const fallback = size.z || 1;
  const ratioX = targetWidth / (size.x || fallback);
  const ratioY = targetHeight / (size.y || fallback);
  // Cover, not contain: the model must read as at least as big as the printed
  // picture on both axes. `box` is that picture's bounds, so taking the larger
  // ratio guarantees scale*size >= target on each. Overflow past the box only
  // shows up as aspect mismatch, which the solver's measured box removes.
  const fit = placement?.fit === 'contain' ? Math.min(ratioX, ratioY) : Math.max(ratioX, ratioY);
  const multiplier = Number.isFinite(placement?.scale) && placement.scale > 0 ? placement.scale : 1;
  root.scale.setScalar(fit * multiplier);
  root.updateMatrixWorld(true);

  box.setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.y -= center.y;
  root.position.z -= box.min.z; // whole model sits in front of the printed card

  return root;
}

export function loadGLTF(card) {
  if (!gltfCache.has(card.model)) {
    gltfCache.set(
      card.model,
      new Promise((resolve, reject) => {
        gltfLoader.load(modelUrl(card), resolve, undefined, (err) => {
          gltfCache.delete(card.model);
          reject(err);
        });
      })
    );
  }
  return gltfCache.get(card.model);
}

// A fresh, un-normalized clone with trustworthy bounding volumes. The orient
// solver needs the raw model (it applies its own rotations and framing), and
// buildModel needs the same starting point, so both go through here.
//
// Missing normals are repaired here too. A dozen models across the library ship
// with POSITION as their only vertex attribute (verified: pyramids, japanese-yen,
// pear, neptune, bus, garlic and friends). glTF says a primitive without NORMAL
// is to be flat-shaded, but GLTFLoader does not synthesise the attribute -- the
// shader then reads a zero normal, every lighting term evaluates to zero, and the
// model renders as a black silhouette. It looks exactly like a model that failed
// to load, except nothing throws. computeVertexNormals() gives the smooth-shaded
// version rather than glTF's flat one; the difference is invisible against
// shading that does not work at all.
//
// KHR_materials_unlit models (universe/star) are skipped: MeshBasicMaterial
// ignores normals, so adding them would only cost memory.
export async function loadModelScene(card) {
  const gltf = await loadGLTF(card);
  const scene = cloneSkinned(gltf.scene);
  scene.traverse((n) => {
    if (n.isMesh && n.geometry) {
      if (!n.geometry.attributes.normal && n.material?.isMeshBasicMaterial !== true) {
        n.geometry.computeVertexNormals();
      }
      n.geometry.computeBoundingBox();
      n.geometry.computeBoundingSphere();
    }
  });
  return { scene, animations: gltf.animations };
}

// One fresh, normalized Object3D per anchor.
//
// `pivot` is the model's own 3D center after normalization (the orientation
// and the in-front-of-card rest position both leave it off the group origin).
// The caller folds it into placementGroup and it is subtracted here, so the
// resting pose is unchanged while user rotation/scale pivot on the model
// itself instead of swinging it around the card plane.
export async function buildModel(card, placement) {
  const { scene: modelScene, animations } = await loadModelScene(card);
  const root = new THREE.Group();
  root.add(modelScene);
  normalizeModel(root, card, placement);

  // Full 3D center: with tilt now a free rotation (not a small nod), pivoting
  // at the base instead of the true center swings the model sideways as it
  // spins (verified: 0.75 units of drift at just 30deg). Centering on all
  // three axes makes tilt and yaw both spin the model in place, matching.
  root.updateMatrixWorld(true);
  const pivot = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
  root.position.sub(pivot);

  return { root, modelScene, animations, pivot };
}
