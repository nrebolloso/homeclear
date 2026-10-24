// Screenshots from walker eye height: node e2e/look.ts <scene> <outdir> x,y,yawDeg[,name] ...
import { CHROME } from './env.ts';
import { chromium } from 'playwright-core';
const [scene, out, ...poses] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-accelerated-video-decode'] });
const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.log('pageerror', String(e)));
await p.goto(`http://localhost:5173/${scene ? `?scene=${scene}` : ""}`);
await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 120000 });
await p.waitForTimeout(4000);
for (const pose of poses) {
  const [x, y, yaw, name] = pose.split(',');
  await p.evaluate(([x, y, yaw]) => (window as any).game.setFree(+x, +y, +yaw * Math.PI / 180), [x, y, yaw]);
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${out}/${name ?? pose}.png` });
}
console.log('fps', await p.evaluate(() => (window as any).game.fps));
await browser.close();
