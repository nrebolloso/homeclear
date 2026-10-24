// Frame-stepped storyboard clip (smooth whatever the machine load): the page clock is driven with game.tick, one
// screenshot per frame, ffmpeg at --fps.  Needs `npm run dev` on 5173 and ffmpeg.
//   node e2e/shot.ts <out.mp4> <seconds> [--url u] [--fps 30] [--setup "<js, awaited once>"] [--cam "<js per frame, t = seconds>"]
// e.g. --setup "game.setThird(true)"  --cam "game.setFly(1.2 - t * 0.1, 0.4, 3.4, -90, -80)"
import { CHROME } from './env.ts';
import { chromium } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2), opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const [out, secs] = args, fps = +opt('fps', '30'), url = opt('url', 'http://localhost:5173/');
const dir = mkdtempSync(`${tmpdir()}/shot-`);
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await browser.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', e => console.log('pageerror', String(e)));
await p.goto(url);
await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 180000 });
await p.evaluate(`(async () => { const game = window.game; game.manual = true; ${opt('setup', '')} })()`);
await p.waitForTimeout(1500);   // replans / splat sorts started by the setup settle before frame 0
const n = Math.round(+secs * fps), cam = opt('cam', '');
for (let k = 0; k < n; k++) {
  await p.evaluate(`(() => { const game = window.game, t = ${k / fps}; ${cam}; game.tick(${1 / fps}); })()`);
  await p.waitForTimeout(40);   // let the splat sort catch up with the camera
  await p.screenshot({ path: `${dir}/${String(k).padStart(5, '0')}.png` });
}
await browser.close();
const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(fps), '-i', `${dir}/%05d.png`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', out]);
rmSync(dir, { recursive: true, force: true });
if (r.status) throw new Error(String(r.stderr));
console.log(`${out}: ${n} frames at ${fps} fps`);
