// fps of the life-size world-model ghosts on this machine's GPU: node e2e/fps_ghosts.ts [--headed]   (needs `npm run dev`)
// Headed needs an unlocked, lit screen: a locked screen throttles Chrome to 1 fps.
import { CHROME } from './env.ts';
import { chromium } from 'playwright-core';
const headed = process.argv.includes('--headed');
const b = await chromium.launch({ executablePath: CHROME, headless: !headed, args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5179/?scene=kitchen4_lighter&demo=1');
await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 60000 });
const G = (f: string) => p.evaluate(`(async () => { const game = window.game; ${f} })()`) as Promise<any>;
const gpu = await p.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2')!; const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
const fps = async (ms: number) => { await p.waitForTimeout(ms); return +(await G('return game.fps')).toFixed(1); };
await G('game.setFly(-0.7, -2.3, 2.3, 55, -36)');   // the ghosts' camera, without them
const room = await fps(6000);
await G("await game.planfix.ready; await game.wmghosts.twoStyles('P10 (training)')");
const two = await fps(6000);
await G("await game.wmghosts.month('before')");
const month = await fps(10000);
console.log(JSON.stringify({ headed, gpu, dpr: await p.evaluate(() => devicePixelRatio), fps: { room, two_styles_and_fan: two, month_60: month } }));
await b.close();
