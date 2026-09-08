import { defineConfig } from 'vite';

// Second dev server, for the tool pages only: npm run tools
//
// Two things force it to be separate from the app server (npm run dev):
//
// 1. Plain HTTP. The app server runs basic-ssl with a self-signed cert so
//    phones can use the camera; an automated browser stops dead at that cert.
//    The tool pages never touch the camera, so they don't need a secure
//    context.
// 2. Its own cacheDir. Two Vite servers sharing node_modules/.vite fight over
//    the dep-optimize cache and the html-proxy registry, and the tool pages'
//    inline <script type="module"> starts answering 500 "No matching HTML proxy
//    module found".
//
// Pair it with `node tools/receiver.mjs`, which is where the headless drivers
// POST their output.

export default defineConfig({
  server: {
    port: 5174,
    https: false,
    strictPort: true
  },
  cacheDir: 'node_modules/.vite-tools'
});
