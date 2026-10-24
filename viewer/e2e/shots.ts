// Still screenshots at chosen walker poses in headless Chrome, against `npm run dev`:
//   node e2e/shots.ts <scene> <outdir> <name>:<x>,<y>,<yawDeg>[,third] ... [--size 1280x720] [--url http://localhost:5179] [--query &pitch=30] [--js 'game.view.back=0.8']
// Each pose: free walk at (x, y) facing yawDeg (floor frame), first person unless ",third"; prints the hazard state per shot.
import { CHROME } from './env.ts';
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const a = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const [scene, outdir] = a, [W, H] = opt('--size', '1280x720').split('x').map(Number);
const poses = a.slice(2).filter((v, i, all) => !v.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
mkdirSync(outdir, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await browser.newPage({ viewport: { width: W, height: H } });
p.on('pageerror', e => console.error('pageerror', e));
await p.goto(`${opt('--url', 'http://localhost:5179')}/?scene=${scene}${opt('--query', '')}`);
await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 180000 });
await p.waitForTimeout(3000);
await p.evaluate(`(async () => { const game = window.game; game.manual = true; ${opt('--js', '')} })()`);   // --js: setup with `game` in scope (may await)
await p.waitForTimeout(1500);
for (const s of poses) {
  const [name, rest] = s.split(':'), [x, y, yaw, third] = rest.split(',');
  const st = await p.evaluate(async ([x, y, yaw, third]) => {
    const game = (window as any).game;
    game.setFree(x, y, (yaw * Math.PI) / 180); game.view.third = third;
    for (let i = 0; i < 4; i++) { game.tick(i ? 0 : 0.05); await new Promise(r => requestAnimationFrame(r)); }   // Spark sorts off-thread
    game.tick(0);
    return { x: game.body.x, y: game.body.y, red: game.state.red, gap: game.state.gap, flash: game.state.legs.filter((l: any) => l.flash).map((l: any) => l.h) };
  }, [+x, +y, +yaw, third === 'third'] as const);
  await p.screenshot({ path: `${outdir}/${name}.png` });
  console.log(name, JSON.stringify(st));
}
await browser.close();
