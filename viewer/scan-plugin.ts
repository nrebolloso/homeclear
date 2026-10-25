import type { Plugin } from 'vite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describeScan } from './src/scan-catalog.ts';

export function scanCatalogPlugin(publicDir: string): Plugin {
  const map = (id: string) => {
    const folder = join(publicDir, 'scene', id), sc = JSON.parse(readFileSync(join(folder, 'scene.json'), 'utf8'));
    const [nx, ny] = sc.grid.shape, data = readFileSync(join(folder, sc.grid.floor));
    const step = Math.max(1, Math.ceil(Math.max(nx, ny) / 70)); let path = '';
    for (let x = 0; x < nx; x += step) for (let y = 0; y < ny; y += step) if (data[x * ny + y]) path += `M${x},${y}h${step}v${step}h-${step}z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${nx} ${ny}"><rect width="100%" height="100%" fill="#142732"/><path d="${path}" fill="#4a8b87"/><title>Scan floor map</title></svg>`;
  };
  const catalog = () => {
    const root = join(publicDir, 'scene');
    if (!existsSync(root)) return [];
    return readdirSync(root).sort().flatMap(id => {
      try {
        const sc = JSON.parse(readFileSync(join(root, id, 'scene.json'), 'utf8'));
        const splat = join(root, id, sc.splat);
        return existsSync(splat) ? [{ ...describeScan(id, sc, statSync(splat).size), map: `scan-maps/${id}.svg` }] : [];
      } catch { return []; }
    });
  };
  return { name: 'scan-catalog',
    configureServer(server) { server.middlewares.use('/scan-maps/', (req, res) => { const id = /^\/([\w.-]+)\.svg$/.exec(req.url ?? '')?.[1]; if (!id || id.includes('..')) { res.statusCode = 404; res.end(); return; } try { res.setHeader('content-type', 'image/svg+xml'); res.end(map(id)); } catch { res.statusCode = 404; res.end(); } }); server.middlewares.use('/scan-catalog.json', (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(catalog())); }); },
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'scan-catalog.json', source: JSON.stringify(catalog()) }); for (const entry of catalog()) { try { this.emitFile({ type: 'asset', fileName: entry.map!, source: map(entry.id) }); } catch { /* no floor map for legacy export */ } } },
  };
}
