// Frame-by-frame screen recording of the viewer in headless Chrome (fixed clock, so the video plays at true speed
// whatever the GPU manages): node e2e/record.ts <scene> <out.mp4> <seconds> [--fps 30] [--size 1280x720]
//   [--at "<t>:<js>"]...   (js runs with `game` in scope at time t; e.g. --at "0:game.view.third=true")
// Every frame: advance the clock, render, let Spark re-sort the splats for the new camera, render again, screenshot.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const a = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const [scene, out, secs] = a;
const fps = +opt('--fps', '30'), [W, H] = opt('--size', '1280x720').split('x').map(Number);
const at = a.flatMap((v, i) => (v === '--at' ? [a[i + 1]] : [])).map(s => { const k = s.indexOf(':'); return { t: +s.slice(0, k), js: s.slice(k + 1), done: false }; });
const BASE = opt('--url', 'http://localhost:5179');

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await browser.newPage({ viewport: { width: W, height: H } });
p.on('pageerror', e => console.error('pageerror', e));
await p.goto(`${BASE}/?scene=${scene}${opt('--query', '')}`);
await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 180000 });
await p.waitForTimeout(3000);
await p.evaluate(() => { (window as any).game.manual = true; });
const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-', '-c:v', 'libx264',
  '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const n = Math.round(+secs * fps), log: any[] = [];
for (let k = 0; k < n; k++) {
  const t = k / fps;
  for (const e of at) if (!e.done && t >= e.t) { e.done = true; await p.evaluate(`(async () => { const game = window.game; ${e.js} })()`); }
  const st = await p.evaluate(async (dt) => {
    const game = (window as any).game;
    game.tick(dt);
    for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));   // Spark sorts off-thread
    game.tick(0);
    return { x: game.body.x, y: game.body.y, yaw: game.body.yaw, red: game.state.red, gap: game.state.gap,
      flash: game.state.legs.filter((l: any) => l.flash).map((l: any) => l.h) };
  }, k ? 1 / fps : 0);
  log.push({ t, ...st });
  ff.stdin.write(await p.screenshot({ type: 'jpeg', quality: 90 }));
}
ff.stdin.end();
await new Promise(r => ff.on('close', r));
await browser.close();
writeFileSync(out.replace(/\.\w+$/, '.frames.json'), JSON.stringify(log));   // per-frame pose + hazard state, for checking the video
const flashes = log.filter(l => l.flash.length), reds = log.filter(l => l.red);
console.log(JSON.stringify({ out, frames: n, fps, leg_flash_frames: flashes.length, max_flash_cm: Math.max(0, ...flashes.flatMap(l => l.flash)) * 100,
  red_frames: reds.length, min_gap_cm: Math.min(...log.map(l => l.gap)) * 100 }));
