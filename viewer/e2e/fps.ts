// Real-time frame rate of the autoplay walk (free-running clock, not the frame-by-frame recorder):
//   node e2e/fps.ts <scene> [--size 1280x720] [--secs 10] [--headed]   (--headed needs DISPLAY)
import { chromium } from 'playwright-core';

const a = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const [W, H] = opt('--size', '1280x720').split('x').map(Number), secs = +opt('--secs', '10');
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: !a.includes('--headed'),
  args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await browser.newPage({ viewport: { width: W, height: H } });
await p.goto(`http://localhost:5179/?scene=${a[0]}`);
await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 180000 });
await p.evaluate(() => (window as any).game.setAuto());
const r = await p.evaluate(async (secs) => {
  const dts: number[] = [], t0 = performance.now(); let last = t0;
  await new Promise<void>(done => { const f = (t: number) => { dts.push(t - last); last = t; t - t0 < secs * 1000 ? requestAnimationFrame(f) : done(); }; requestAnimationFrame(f); });
  dts.shift(); dts.sort((x, y) => x - y);
  return { frames: dts.length, mean_fps: 1000 / (dts.reduce((s, x) => s + x, 0) / dts.length), p95_frame_ms: dts[Math.floor(0.95 * dts.length)],
    gpu: (() => { const gl = document.createElement('canvas').getContext('webgl2')!; const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; })() };
}, secs);
console.log(JSON.stringify({ size: `${W}x${H}`, headed: a.includes('--headed'), ...r }));
await browser.close();
