// Dev-only API: the game writes Cosmos exports to public/exports/<job>/ and lists clips in public/clips/.
import { defineConfig } from 'vite';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PUB = join(import.meta.dirname, 'public');

export default defineConfig({
  server: { port: 5179, strictPort: true },   // README, e2e/ and scripts/ all use 5179
  worker: { format: 'es' },
  plugins: [{
    name: 'rehearsal-api',
    configureServer(server) {
      server.middlewares.use('/api/export/', (req, res) => {
        // only <job>/<file> or <job>/walker/<file>: nothing can escape public/exports
        const m = /^\/([\w-]{1,64})\/((?:walker\/)?[\w.-]{1,64})$/.exec(req.url ?? '');
        if (req.method !== 'POST' || !m || m[2].includes('..')) { res.statusCode = 400; res.end('bad export path'); return; }
        const parts: Buffer[] = [];
        req.on('data', c => parts.push(c));
        req.on('end', () => {
          const f = join(PUB, 'exports', m[1], m[2]);
          mkdirSync(dirname(f), { recursive: true });
          writeFileSync(f, Buffer.concat(parts));
          res.end('ok');
        });
      });
      server.middlewares.use('/api/clips', (_req, res) => {
        const d = join(PUB, 'clips');
        const clips = existsSync(d) ? readdirSync(d).filter(f => f.endsWith('.json'))
          .map(f => ({ ...JSON.parse(readFileSync(join(d, f), 'utf8')), meta: f }))
          .filter(c => typeof c.file === 'string' && existsSync(join(d, c.file))) : [];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(clips));
      });
    },
  }],
});
