import type { Plugin } from 'vite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describeScan } from './src/scan-catalog.ts';

export function scanCatalogPlugin(publicDir: string): Plugin {
  const catalog = () => {
    const root = join(publicDir, 'scene');
    if (!existsSync(root)) return [];
    return readdirSync(root).sort().flatMap(id => {
      try {
        const sc = JSON.parse(readFileSync(join(root, id, 'scene.json'), 'utf8'));
        const splat = join(root, id, sc.splat);
        return existsSync(splat) ? [describeScan(id, sc, statSync(splat).size)] : [];
      } catch { return []; }
    });
  };
  return { name: 'scan-catalog',
    configureServer(server) { server.middlewares.use('/scan-catalog.json', (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(catalog())); }); },
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'scan-catalog.json', source: JSON.stringify(catalog()) }); },
  };
}
