// "Export for Cosmos" headlessly, against `npm run dev`:  node e2e/export.ts <scene> [--query &pitch=30]  -> prints the job name
import { chromium } from 'playwright-core';
const a = process.argv.slice(2), opt = (k: string, d: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.error('pageerror', e));
await p.goto(`http://localhost:5179/?scene=${a[0]}${opt('--query', '')}`);
await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 180000 });
const job = await p.evaluate(() => (window as any).game.exportForCosmos());
console.error(JSON.stringify(await p.evaluate(() => (window as any).game.lastExport)));
console.log(job);
await browser.close();
