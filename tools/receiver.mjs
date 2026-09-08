// Write-back server for the headless tool drivers.
//
//   node tools/receiver.mjs        listens on http://localhost:5999
//
// tools/compile-headless.js and tools/solve-headless.js run inside a browser,
// which has nowhere to put a file: showDirectoryPicker() needs a human, and a
// download lands in the download folder under whatever name Chrome picks. They
// POST their output here instead and this writes it into assets/.
//
//   POST /targets/<deck>.mind   ->  assets/targets/<deck>.mind   (binary)
//   POST /placements            ->  assets/placements.json       (JSON)
//
// CORS is required: the tool pages are served by Vite on another port, so every
// POST is cross-origin and Chrome preflights the Content-Type header.
//
// Only two paths are accepted and <deck> is checked against the same slug rule
// the rest of the pipeline uses -- this writes to disk, so nothing shapes a
// path but this file.

import { writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetsDir = path.join(root, 'assets', 'targets');
const placementsPath = path.join(root, 'assets', 'placements.json');

const PORT = 5999;
const DECK_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const send = (code, text) => res.writeHead(code, { ...CORS, 'Content-Type': 'text/plain' }).end(text);

  if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end();
  if (req.method !== 'POST') return send(405, 'POST only');

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/placements') {
      const buf = await body(req);
      // Parse before writing: a truncated or malformed POST must not replace a
      // good placements.json, which holds every deck's hand-tuned work.
      JSON.parse(buf.toString('utf8'));
      await writeFile(placementsPath, buf);
      console.log(`placements.json  ${(buf.length / 1024).toFixed(0)}KB`);
      return send(200, 'ok');
    }

    const match = url.pathname.match(/^\/targets\/([^/]+)\.mind$/);
    if (match) {
      const deck = decodeURIComponent(match[1]);
      if (!DECK_RE.test(deck)) return send(400, `bad deck name: ${deck}`);
      const buf = await body(req);
      await mkdir(targetsDir, { recursive: true });
      await writeFile(path.join(targetsDir, `${deck}.mind`), buf);
      console.log(`${deck}.mind  ${(buf.length / 1e6).toFixed(1)}MB`);
      return send(200, 'ok');
    }

    return send(404, 'unknown path');
  } catch (err) {
    console.error(`FAIL ${url.pathname}: ${err.message}`);
    return send(500, err.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`receiver listening on http://localhost:${PORT}`);
  console.log(`  POST /targets/<deck>.mind -> assets/targets/`);
  console.log(`  POST /placements          -> assets/placements.json`);
});
