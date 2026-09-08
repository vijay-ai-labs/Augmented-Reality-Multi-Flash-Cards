// "Place Here": pin a marker-tracked model into the room using nothing but the
// phone's gyroscope.
//
// THIS IS A 3DOF ILLUSION, NOT WORLD TRACKING. There is no positional tracking
// here -- no WebXR, no ARKit/ARCore, no SLAM. All we get is device orientation.
// The trick: MindAR keeps its camera at the origin and moves the anchors, so
// scene space is camera space. Detach the model into scene space and it is
// stuck to the screen; counter-rotate its position by the phone's rotation
// since placement and it appears stuck to the ROOM instead.
//
// Rotating the phone in place works. Physically walking a long way desyncs the
// illusion, because translation is never compensated. That is the accepted
// tradeoff, not a bug to fix.
//
// This module is deliberately free of DOM and UI code: it moves three.js
// objects and owns its own state. Buttons, status text and haptics belong to
// the caller (see src/ar-view.js).

import * as THREE from 'three';

const _euler = new THREE.Euler();
const _inverse = new THREE.Quaternion();

// Below this, a matrix basis vector is zero for our purposes and
// Matrix4.decompose() would divide by it. See #readTransforms.
const MIN_BASIS_LENGTH = 1e-8;

/**
 * Device orientation -> quaternion.
 *
 * `Euler(beta, alpha, -gamma, 'YXZ')` is the same conversion three's old
 * DeviceOrientationControls used: the negated gamma and the YXZ order are what
 * map DeviceOrientationEvent's Tait-Bryan angles onto three's Y-up frame, with
 * alpha (compass heading) landing on Y.
 *
 * The two corrections that class applied afterwards -- a -90deg X rotation for
 * the camera looking out the back of the device, and screen.orientation.angle
 * for landscape -- are deliberately skipped. Both are a CONSTANT right-multiply
 * C, and the world-frame delta used below cancels it exactly:
 *
 *   (Q1*C) * (Q0*C)^-1 = Q1 * Q0^-1
 *
 * So yaw compensation with the phone held upright -- the motion that actually
 * matters here -- is exact without them. Off-axis tilt and landscape drift a
 * little, since the fully correct correction would be conjugated by the camera
 * pose at placement time. Accepted for the simplicity.
 */
function quaternionFromDeviceOrientation(out, alphaDeg, betaDeg, gammaDeg) {
  _euler.set(
    THREE.MathUtils.degToRad(betaDeg),
    THREE.MathUtils.degToRad(alphaDeg),
    -THREE.MathUtils.degToRad(gammaDeg),
    'YXZ'
  );
  return out.setFromEuler(_euler);
}

export class PlacementManager {
  #placed = false;
  #listening = false;

  // Which of the two orientation events is feeding #deviceQuat. See
  // handleOrientation for why there are two and how one wins.
  #source = null;

  // Live sensor orientation, and the snapshot taken at the moment of placement.
  #deviceQuat = new THREE.Quaternion();
  #placementQuat = new THREE.Quaternion();
  #hasOrientationData = false;

  // Set when a placement happened before the sensor had ever reported: there is
  // no reference orientation to measure against yet, so the first real reading
  // becomes it and update() holds still until then.
  #referencePending = false;

  // Resolvers waiting on whenOrientationReady().
  #readyWaiters = new Set();

  // The model's world transform at the moment of placement. Position is the
  // only one the per-frame update touches.
  #placedWorldPos = new THREE.Vector3();
  #placedWorldQuat = new THREE.Quaternion();
  #placedWorldScale = new THREE.Vector3(1, 1, 1);

  // The local transform the model had under its anchor, restored on release.
  // Deliberately NOT hardcoded to identity: in this app the placed object is a
  // group carrying the card's static placement offset and model pivot, so
  // zeroing it would move the model off its printed picture on return.
  #localPos = new THREE.Vector3();
  #localQuat = new THREE.Quaternion();
  #localScale = new THREE.Vector3(1, 1, 1);

  // Whether the transforms above hold a usable pose captured at tap time, and
  // whether #placementQuat was captured alongside it.
  #hasCapture = false;
  #captureQuatValid = false;

  // Scratch, so update() allocates nothing per frame.
  #delta = new THREE.Quaternion();
  #nextPos = new THREE.Vector3();

  #onOrientation = (event) => this.handleOrientation(event);

  get isPlaced() {
    return this.#placed;
  }

  // True once the sensor has actually produced a reading. Some browsers and
  // embedded webviews attach the listener happily and never fire usable data;
  // the caller can use this to say so instead of looking silently broken.
  get hasOrientationData() {
    return this.#hasOrientationData;
  }

  /** Idempotent: repeated Place -> Return -> Place cycles must not stack listeners. */
  startListening() {
    if (this.#listening) return;
    this.#listening = true;
    window.addEventListener('deviceorientation', this.#onOrientation);
    // Phones with a magnetometer but no gyroscope never fire 'deviceorientation'
    // in Chrome -- its relative-orientation sensor requires a gyro -- yet do
    // fire the absolute event. Without this second listener those devices look
    // like the model simply refuses to stay put.
    window.addEventListener('deviceorientationabsolute', this.#onOrientation);
  }

  stopListening() {
    if (!this.#listening) return;
    this.#listening = false;
    window.removeEventListener('deviceorientation', this.#onOrientation);
    window.removeEventListener('deviceorientationabsolute', this.#onOrientation);
  }

  handleOrientation(event) {
    // Fires with all-null angles on browsers that expose the event but no
    // sensor. Taking those as zeroes would snap the model somewhere arbitrary.
    if (event?.alpha == null) return;

    // Two event types can feed this. 'deviceorientation' is gyro-fused and free
    // of magnetic jitter, so it wins outright whenever it works;
    // 'deviceorientationabsolute' is only the fallback for phones whose
    // relative sensor never fires. The winner is frozen once something is
    // placed -- swapping source mid-placement changes the reference frame and
    // would teleport the model.
    if (this.#source === null || (!this.#placed && event.type === 'deviceorientation')) {
      this.#source = event.type;
    }
    if (event.type !== this.#source) return;

    this.#hasOrientationData = true;
    quaternionFromDeviceOrientation(this.#deviceQuat, event.alpha, event.beta ?? 0, event.gamma ?? 0);

    // First reading after a placement that had none: adopt it as the reference
    // so the delta starts at zero. Measuring against an identity reference
    // instead is what used to fling the model across the screen, since alpha is
    // commonly ~270 and reads as most of a turn.
    if (this.#referencePending) {
      this.#referencePending = false;
      this.#placementQuat.copy(this.#deviceQuat);
    }

    this.#settleReadyWaiters(true);
  }

  /**
   * Resolves true once the sensor has reported, false if it has not by the
   * timeout. Purely informational -- placement never waits on it.
   */
  whenOrientationReady(timeoutMs = 2000) {
    if (this.#hasOrientationData) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = (ready) => {
        clearTimeout(timer);
        this.#readyWaiters.delete(waiter);
        resolve(ready);
      };
      const timer = setTimeout(() => waiter(false), timeoutMs);
      this.#readyWaiters.add(waiter);
    });
  }

  #settleReadyWaiters(ready) {
    if (this.#readyWaiters.size === 0) return;
    for (const waiter of [...this.#readyWaiters]) waiter(ready);
  }

  /**
   * The full tap-to-place flow, including the iOS permission dance.
   *
   * MUST be called synchronously from a user gesture: iOS 13+ only honours
   * DeviceOrientationEvent.requestPermission() from a direct tap, and will not
   * accept it proactively or after a long await chain.
   *
   * @returns {Promise<'ok'|'denied'|'no-pose'>} 'denied' when motion access was
   *   refused and 'no-pose' when the marker was never tracked well enough to
   *   place from. In both cases nothing was reparented and the caller should
   *   restore its prior UI.
   */
  async requestPermissionAndPlace(root, scene, anchorGroup) {
    if (this.#placed) return 'ok';

    // Snapshot the pose NOW, synchronously, while the marker is still tracked.
    // The permission dialog below can easily outlive tracking, and a lost
    // MindAR anchor is parked on an all-zero matrix -- see #readTransforms.
    this.capture(root);

    const request = window.DeviceOrientationEvent?.requestPermission;
    if (typeof request === 'function') {
      // iOS 13+.
      let response;
      try {
        response = await request.call(window.DeviceOrientationEvent);
      } catch {
        return 'denied'; // Rejects when not called from a genuine user gesture.
      }
      if (response !== 'granted') return 'denied';
    }
    // Android and older iOS have no permission gate: just start listening.

    this.startListening();

    // No wait for a first reading here on purpose. Blocking on the sensor made
    // placement feel laggy and, worse, timed out on slow-starting phones and
    // then placed against an identity reference anyway. The reference is now
    // filled in lazily by handleOrientation instead.
    return this.place(root, scene, anchorGroup) ? 'ok' : 'no-pose';
  }

  /**
   * Snapshot `root`'s current world transform for a later place() to fall back
   * on. Call it synchronously from the tap, while the marker is known tracked.
   *
   * @returns {boolean} false when the anchor has no usable pose right now.
   */
  capture(root) {
    this.#hasCapture = this.#readTransforms(root);
    // Pair the pose with the orientation the phone had at the same instant, so
    // a placement that falls back to this snapshot still lands the model where
    // the card was in the room rather than where the phone is now pointing.
    this.#captureQuatValid = this.#hasCapture && this.#hasOrientationData;
    if (this.#captureQuatValid) this.#placementQuat.copy(this.#deviceQuat);
    return this.#hasCapture;
  }

  /**
   * Read `root`'s world and local transforms into the placement fields.
   *
   * Guarded rather than a plain decompose(): MindAR parks an untracked anchor
   * on an all-zero matrix (`invisibleMatrix`), and Matrix4.decompose() divides
   * the rotation part by each basis length, so a zero basis yields scale
   * (0,0,0) and a NaN quaternion. Nothing throws -- the model just collapses to
   * a point and never comes back, which is what a placement made across the
   * iOS permission dialog used to do.
   *
   * @returns {boolean} false when the matrix is degenerate or non-finite.
   */
  #readTransforms(root) {
    root.updateWorldMatrix(true, true);
    const e = root.matrixWorld.elements;
    for (let i = 0; i < 16; i++) {
      if (!Number.isFinite(e[i])) return false;
    }
    const sx = Math.hypot(e[0], e[1], e[2]);
    const sy = Math.hypot(e[4], e[5], e[6]);
    const sz = Math.hypot(e[8], e[9], e[10]);
    if (sx < MIN_BASIS_LENGTH || sy < MIN_BASIS_LENGTH || sz < MIN_BASIS_LENGTH) return false;

    root.matrixWorld.decompose(this.#placedWorldPos, this.#placedWorldQuat, this.#placedWorldScale);

    // Remember the local transform so release() can hand the model back to the
    // anchor exactly as it found it.
    this.#localPos.copy(root.position);
    this.#localQuat.copy(root.quaternion);
    this.#localScale.copy(root.scale);
    return true;
  }

  /**
   * Reparent `root` from `anchorGroup` into `scene`, preserving how it looks.
   *
   * @returns {boolean} false when there is no usable pose, live or captured, in
   *   which case nothing was moved.
   */
  place(root, scene, anchorGroup) {
    if (this.#placed) return true;

    // A live pose is always preferable: it is where the card is right now.
    // Only when tracking has dropped does the tap-time snapshot get used.
    const live = this.#readTransforms(root);
    if (live) this.#captureQuatValid = false;
    else if (!this.#hasCapture) return false;

    if (this.#captureQuatValid) {
      // #placementQuat already holds the tap-time orientation that matches the
      // captured pose. Leave it alone.
      this.#referencePending = false;
    } else if (this.#hasOrientationData) {
      this.#placementQuat.copy(this.#deviceQuat);
      this.#referencePending = false;
    } else {
      // Sensor has not reported yet. Hold still until it does.
      this.#referencePending = true;
    }

    anchorGroup.remove(root);
    scene.add(root);

    // Reapply immediately: scene space is camera space in MindAR, and the
    // captured world transform is already expressed there, so the model does
    // not jump at the instant of detachment.
    root.position.copy(this.#placedWorldPos);
    root.quaternion.copy(this.#placedWorldQuat);
    root.scale.copy(this.#placedWorldScale);

    // Marker tracking may well have dropped during the permission prompt, and
    // whatever ran on target-lost may have hidden this. Placement outlives the
    // marker by design, so force it back.
    root.visible = true;

    this.#placed = true;
    this.#hasCapture = false;
    return true;
  }

  /** Per-frame counter-rotation. No-op unless placed. */
  update(root) {
    if (!this.#placed || !root) return;
    // Placed before the sensor ever reported: no reference frame exists yet, so
    // leave the model exactly where it was put. handleOrientation adopts the
    // first reading as the reference and this starts moving from zero delta.
    if (this.#referencePending) return;

    // World-frame delta: Q1 * Q0^-1. Order matters. The phone-frame delta
    // (Q0^-1 * Q1) describes the same rotation about an axis in the phone's
    // own frame, and compensating with it swings the model the wrong way.
    this.#delta.copy(this.#deviceQuat).multiply(_inverse.copy(this.#placementQuat).invert());
    this.#delta.invert();

    // Only the POSITION is corrected. The model keeps the orientation it was
    // placed with -- also rotating it by the delta would spin it in place as
    // the viewer walks around, which is exactly what pinning should prevent.
    root.position.copy(this.#nextPos.copy(this.#placedWorldPos).applyQuaternion(this.#delta));
  }

  /** Hand the model back to its marker anchor. */
  release(root, scene, anchorGroup) {
    if (!this.#placed) return;
    this.#placed = false;
    this.#referencePending = false;
    this.#hasCapture = false;
    this.#captureQuatValid = false;

    scene.remove(root);
    anchorGroup.add(root);

    // Back to the local transform the anchor's tracked matrix expects, so a
    // re-place later starts from a clean state.
    root.position.copy(this.#localPos);
    root.quaternion.copy(this.#localQuat);
    root.scale.copy(this.#localScale);
  }

  /** Session teardown. Leaves no listener behind for the next AR session. */
  dispose() {
    this.stopListening();
    this.#placed = false;
    this.#hasOrientationData = false;
    this.#referencePending = false;
    this.#hasCapture = false;
    this.#captureQuatValid = false;
    this.#source = null;
    this.#settleReadyWaiters(false);
  }
}
