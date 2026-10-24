// same fly-camera poses in each scene, UI hidden -> <out>/<scene>_<n>.png   usage: POSES='[[x,y,z,yaw,pitch],...]' node scripts/cmpshots.mjs <out> <scene>...
import { chromium } from 'playwright-core';
const [out, ...scenes] = process.argv.slice(2);
// floor-frame [x, y, z, yaw, pitch] per view, e.g. capture cameras stepped 1 m back along their view (off the filmed path)
const poses = JSON.parse(process.env.POSES);
const b = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const s of scenes) {
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', e => console.error(s, 'pageerror', e.message));
  await p.goto(`http://localhost:5179/?scene=${s}`);
  await p.waitForFunction(() => window.game?.ready, null, { timeout: 180000 });
  await p.waitForTimeout(3000);
  await p.mouse.click(640, 600); await p.keyboard.press('KeyF'); await p.waitForTimeout(300);
  await p.addStyleTag({ content: '.panel, #hud { visibility: hidden !important }' });
  for (const [n, [x, y, z, yaw, pitch]] of poses.entries()) {
    await p.evaluate(([x, y, z, yaw, pitch]) => { Object.assign(window.game.fly, { x, y, z }); Object.assign(window.game.body, { yaw, pitch }); }, [x, y, z, yaw, pitch]);
    await p.waitForTimeout(1500);
    await p.screenshot({ path: `${out}/${s}_${n}.png` });
  }
  await p.close();
}
await b.close();
