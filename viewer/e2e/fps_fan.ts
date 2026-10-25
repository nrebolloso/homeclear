// fps of the live futures fan on this machine's GPU: node e2e/fps_fan.ts [--headed]   (needs `npm run dev`)
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
// mean of 1 s readings after a 3 s settle, and the sample count the fan ended on
const fps = async (s: number) => { await p.waitForTimeout(3000); let t = 0; for (let i = 0; i < s; i++) { await p.waitForTimeout(1000); t += await G('return game.fps'); } return { fps: +(t / s).toFixed(1), n: await G('return game.fan.state().n') }; };
await G('game.setFree(-0.6, 2.05, -0.9); game.setThird(true, 0.9, 1.1)');   // the recording's view, at the fridge facing the mat
await p.waitForTimeout(4000);
// off/on alternated 4 times: other load on the machine drifts by more than the fan costs
const runs: Record<string, number[]> = { off: [], learned: [], hand: [] }, ns: number[] = [];
for (let i = 0; i < 4; i++) {
  await G('game.fan.set(false)'); runs.off.push((await fps(6)).fps);
  await G("game.fan.setModel('learned'); game.fan.set(true)"); const l = await fps(6); runs.learned.push(l.fps); ns.push(l.n);
  await G("game.fan.setModel('hand')"); runs.hand.push((await fps(6)).fps);
}
const mean = (v: number[]) => +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1);
console.log(JSON.stringify({ headed, gpu, dpr: await p.evaluate(() => devicePixelRatio), runs, n_learned: ns, mean: { off: mean(runs.off), learned: mean(runs.learned), hand: mean(runs.hand) }, ratio: +(mean(runs.learned) / mean(runs.off)).toFixed(3) }));
await b.close();
