// Record the default demo walk to an mp4: node e2e/record.ts <out.mp4> [seconds] [url]   (needs `npm run dev` on 5173, ffmpeg)
import { CHROME } from './env.ts';
import { chromium } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const [out, secs = '30', url = 'http://localhost:5173/'] = process.argv.slice(2);
const dir = mkdtempSync(`${tmpdir()}/rec-`);
const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-accelerated-video-decode'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, recordVideo: { dir, size: { width: 1600, height: 900 } } });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('pageerror', String(e)));
const tg = Date.now();
await p.goto(url);
await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 120000 });
const t0 = Date.now();
await p.waitForTimeout(+secs * 1000);
console.log('fps', await p.evaluate(() => (window as any).game.fps));
await ctx.close(); await browser.close();
const webm = `${dir}/${readdirSync(dir)[0]}`;
const skip = (t0 - tg) / 1000;   // trim the loading screen: keep from page-ready on
const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(skip), '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', out], { stdio: 'inherit' });
rmSync(dir, { recursive: true });
process.exit(r.status ?? 1);
