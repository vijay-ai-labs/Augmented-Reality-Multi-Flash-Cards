// Turns a failed camera start into a sentence a parent can act on.
//
// Lives apart from ar-view.js so pinned mode can reuse it without pulling
// MindAR into that bundle. MindAR rejects start() with `undefined` when the
// camera fails, which is why this probes getUserMedia itself to find out why.

export async function cameraFailReason(original) {
  if (original?.message) return original.message;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((track) => track.stop());
    return 'Camera works, but AR tracking failed to load. Check the .mind target file.';
  } catch (err) {
    switch (err?.name) {
      case 'NotAllowedError':
        return 'Camera permission was denied. Allow camera access for this site and try again.';
      case 'NotFoundError':
        return 'No camera was found on this device.';
      case 'NotReadableError':
        return 'The camera is already in use by another app. Close it and try again.';
      default:
        return `Camera error: ${err?.name ?? 'unknown'}.`;
    }
  }
}
