// "Export for Cosmos" headlessly, against `npm run dev` (port 5179). Prints the job name (stdout), details (stderr).
//   node e2e/export.ts <scene> [--query &pitch=30] [--persona patient] [--route 0] [--fixes remove_rug,tape_cable]
//                      [--option 1] [--night] [--hero] [--condition night] [--scenario name] [--prompt "..."]
// --fixes: configured fixes applied in order; --option N: run Suggest layouts and apply option N (0 quick .. 2 full).
import { CHROME } from './env.ts';
import { chromium } from 'playwright-core';
const a = process.argv.slice(2), opt = (k: string, d: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; }, flag = (k: string) => a.includes(k);
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.error('pageerror', e));
await p.goto(`http://localhost:5179/?scene=${a[0]}${opt('--query', '')}`);
await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 180000 });
const G = (f: string, arg?: any) => p.evaluate(([f, arg]) => (window as any).game[f as string](arg), [f, arg]);
if (opt('--persona', '')) await G('setPersona', opt('--persona', ''));
if (opt('--route', '')) await G('selectRoute', +opt('--route', '0'));
if (opt('--fixes', '')) await G('applyFixes', opt('--fixes', '').split(','));
if (opt('--option', '')) { await G('suggest'); await G('applyOption', +opt('--option', '0')); }
await G('setNight', flag('--night'));
const job = await G('exportForCosmos', { hero: flag('--hero'), condition: opt('--condition', '') || undefined,
  scenario: opt('--scenario', '') || undefined, prompt: opt('--prompt', '') || undefined });
console.error(JSON.stringify({ ...(await p.evaluate(() => (window as any).game.lastExport)), layout_key: await G('layoutKey') }));
console.log(job);
await browser.close();
