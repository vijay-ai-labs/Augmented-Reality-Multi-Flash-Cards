import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// The card/model/target library lives in assets/ at the project root rather
// than in public/, because publicDir is copied into dist/ on every build and
// this library is several hundred MB — see the Production section of the
// README, which puts it on object storage and points ASSET_BASE at it.
//
// The cost is that `vite preview` serves dist/ only, so a production build
// answers 404 for the manifest and shows "No Categories Found" — the one thing
// preview exists to catch. This middleware serves those directories straight
// from the project root, matching what the dev server already does. Only the
// data directories are handled: dist/assets/ is where Vite puts the built JS
// and CSS, so a blanket /assets/ handler would shadow the app's own bundle.
const ASSET_DIRS = /^\/assets\/(cards|models|targets|audios)\//;
const ASSET_FILES = new Set(['/assets/manifest.json', '/assets/placements.json']);

const MIME = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mind': 'application/octet-stream'
};

function serveAssetsInPreview() {
  const root = process.cwd();
  return {
    name: 'serve-assets-in-preview',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = decodeURIComponent((req.url ?? '').split('?')[0]);
        if (!ASSET_FILES.has(pathname) && !ASSET_DIRS.test(pathname)) return next();

        // The patterns above already exclude "..", but resolve and re-check
        // anyway: this hands out files by request path.
        const file = path.resolve(root, `.${pathname}`);
        if (!file.startsWith(path.join(root, 'assets') + path.sep)) return next();

        let size;
        try {
          const stats = statSync(file);
          if (!stats.isFile()) return next();
          size = stats.size;
        } catch {
          return next();
        }

        res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
        res.setHeader('Content-Length', size);
        createReadStream(file).pipe(res);
      });
    }
  };
}

export default defineConfig({
  // Camera (getUserMedia) requires a secure context. basicSsl serves the dev
  // server over https with a self-signed cert so phones on the LAN can use the
  // camera — accept the browser's certificate warning once on the device.
  plugins: [basicSsl(), serveAssetsInPreview()],
  server: {
    port: 5173,
    https: true
  },
  build: {
    target: 'es2020'
  }
});
