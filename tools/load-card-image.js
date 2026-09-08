// Loads a card image for MindAR target compilation, matted onto white.
//
// Shared by the interactive compiler (compile-targets.html) and the headless
// driver (compile-headless.js); both MUST use it, or the same deck compiles
// differently depending on which one ran.
//
// Why the matte: MindAR's compiler (node_modules/mind-ar/src/image-target/
// compiler-base.js) draws the image onto a fresh canvas and greys it with
// (R+G+B)/3 -- alpha is never consulted. A fresh canvas starts transparent
// BLACK, so any transparent region of a card compiles as solid black. Ten of the
// numbers cards are rounded-white artwork with a transparent margin outside the
// corner radius: they compiled with a hard black frame that does not exist on
// the printed card, which is white paper. That frame is the highest-contrast
// edge in the image, so it dominated feature extraction and the camera could
// never reproduce it -- those cards simply would not track.
//
// Returns a canvas, not an Image. MindAR only reads .width/.height and passes
// the object to drawImage(), and a canvas satisfies both.
export function loadCardImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      // Paper, then ink. Card stock is white; matching it here is what makes the
      // compiled target look like what the camera will actually see.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    };
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src.startsWith('/') ? src : `/${src}`;
  });
}
