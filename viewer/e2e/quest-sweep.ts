// Frame rate along the route on a real Quest, nobody wearing it: loads a scene in the Quest Browser, enters VR from the
// laptop (a DevTools click counts as the user's), puts the head every --step m along the route facing 4 ways
// (game.debug.xrPlace), and reads game.fps at each. Over USB, with `npm run dev:quest` running:
//   adb forward tcp:9223 localabstract:chrome_devtools_remote   (and keep the headset awake: README, VR)
//   node e2e/quest-sweep.ts <scene> [--hz 72] [--query 'stddev=2'] [--step 0.75] [--settle 2.2]   -> table + e2e/quest-sweep.json
import { writeFileSync } from 'node:fs';

const a = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const scene = a[0] ?? 'game_synth', hz = opt('--hz', ''), extra = opt('--query', ''), step = +opt('--step', '0.75'), settle = +opt('--settle', '2.2');
const sleep = (s: number) => new Promise(r => setTimeout(r, s * 1000));

const tabs = await (await fetch('http://localhost:9223/json')).json().catch(() => { throw new Error('no DevTools on :9223: adb forward tcp:9223 localabstract:chrome_devtools_remote'); });
const tab = tabs.find((t: any) => t.type === 'page' && t.url.includes('localhost:5179'));
if (!tab) throw new Error('open http://localhost:5179 in the Quest Browser first (adb shell am start ...)');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.addEventListener('message', e => { const m = JSON.parse(String(e.data)); pending.get(m.id)?.(m); pending.delete(m.id); });
/** Evaluate in the page as a user gesture (WebXR only starts a session from one). */
const E = (expr: string): Promise<any> => new Promise((res, rej) => {
  const n = ++id;
  pending.set(n, m => (m.result?.exceptionDetails ? rej(new Error(m.result.exceptionDetails.exception?.description ?? 'eval failed')) : res(m.result?.result?.value)));
  ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true } }));
});
const until = async (expr: string, s = 60) => { for (let t = 0; t < s * 4; t++) { if (await E(expr).catch(() => false)) return; await sleep(0.25); } throw new Error(`timed out: ${expr}`); };

const url = `http://localhost:5179/?scene=${scene}${hz ? `&hz=${hz}` : ''}${extra ? `&${extra}` : ''}`;   // --query 'stddev=2&maxpx=128'
await E(`location.href = ${JSON.stringify(url)}`).catch(() => {});   // the navigation drops this evaluation
await sleep(2);
await until('!!window.game?.ready', 120);
await E('[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "ENTER VR").click()');
await until('!!game.xr', 15);
await sleep(1.5);
const meta = await E('({ rate: game.debug.renderer.xr.getSession().frameRate, gpu: (() => { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl.getExtension("WEBGL_debug_renderer_info"); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "?"; })() })');
// stops along the route (its xy is the walker frame's centre), every `step` m
const stops: [number, number, number][] = await E(`(() => { const xy = game.current().xy, out = []; let acc = Infinity;
  for (let k = 1; k < xy.length; k++) { const d = Math.hypot(xy[k][0] - xy[k - 1][0], xy[k][1] - xy[k - 1][1]); acc += d;
    if (acc >= ${step}) { out.push([xy[k][0], xy[k][1], Math.atan2(xy[k][1] - xy[k - 1][1], xy[k][0] - xy[k - 1][0])]); acc = 0; } }
  return out; })()`);
console.log(`${scene} on ${meta.gpu} at ${meta.rate} Hz: ${stops.length} stops x 4 directions, ${settle} s each`);
const rows: { x: number; y: number; dir: string; yaw: number; fps: number }[] = [];
const DIRS = [['ahead', 0], ['left', Math.PI / 2], ['back', Math.PI], ['right', -Math.PI / 2]] as const;
for (const [x, y, heading] of stops) {
  const line: string[] = [];
  for (const [dir, off] of DIRS) {
    await E(`game.debug.xrPlace(${x}, ${y}, ${heading + off})`);
    await sleep(settle);   // game.fps is a 1 s window: settle past it at the new view
    const fps = await E('game.fps');
    rows.push({ x, y, dir, yaw: heading + off, fps });
    line.push(`${dir} ${fps.toFixed(0).padStart(3)}`);
  }
  console.log(`(${x.toFixed(2).padStart(5)}, ${y.toFixed(2).padStart(5)})  ${line.join('  ')}`);
}
const f = rows.map(r => r.fps).sort((p, q) => p - q), rate = meta.rate;
const ok = rows.filter(r => r.fps >= rate * 0.97).length;
console.log(`min ${f[0].toFixed(1)}  median ${f[Math.floor(f.length / 2)].toFixed(1)}  at full rate ${ok}/${rows.length}`);
for (const r of [...rows].sort((p, q) => p.fps - q.fps).slice(0, 3)) console.log(`  worst: (${r.x.toFixed(2)}, ${r.y.toFixed(2)}) looking ${r.dir}: ${r.fps.toFixed(1)} fps`);
writeFileSync(new URL('quest-sweep.json', import.meta.url), JSON.stringify({ scene, ...meta, step, settle, rows }, null, 1));
ws.close();
