// End-to-end checks in headless Chrome on the laptop GPU, against `npm run dev`:
//   node e2e/run.ts [http://localhost:5179]        -> prints PASS/FAIL per check, writes e2e/results.json
// Needs the synthetic scenes (tests/make_game_scene.py) and the Python venv (for tests/make_test_clip.py).
import { CHROME, ROOT, PYTHON } from './env.ts';
import { chromium, type Page } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5179';

const results: { check: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => { results.push({ check: name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); };
// SHOTS=<dir> also saves a screenshot at each visual check (proof/screenshots)
const shot = (p: Page, name: string) => process.env.SHOTS ? p.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : null;
const G = (p: Page, f: string) => p.evaluate(`(async () => { const game = window.game; ${f} })()`) as Promise<any>;

const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
    '--disable-accelerated-video-decode'] });   // headless: HW decode + ANGLE stalls seeks and loses the WebGL context
async function open(scene: string) {
  const p = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors: string[] = [];
  p.on('pageerror', e => errors.push(String(e)));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(`${BASE}/?scene=${scene}`);
  await p.waitForFunction(() => (window as any).game?.ready, null, { timeout: 60000 });
  return { p, errors };
}

try {
  const { p, errors } = await open('game_synth');
  const gpu = await p.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2')!; const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; });
  await p.waitForTimeout(6000);
  const fps = await G(p, 'return game.fps');
  check('fps (autoplay, 1600x900)', fps >= 30, `${fps.toFixed(1)} fps on ${gpu}`);
  const base = await G(p, 'return { pm: game.current().per_month, len: game.current().length_m }');

  // 1. drive into the 1.5 cm rug: a leg flashes with the measured height
  await G(p, 'game.setFree(1.2, 1.3, 0)');
  await p.keyboard.down('KeyW');
  const flash = await p.waitForFunction(() => (window as any).game.state.legs.find((l: any) => l.flash), null, { timeout: 15000 }).then(h => h.jsonValue()).catch(() => null);
  await shot(p, 'hazard_rug_leg_flash');
  await p.keyboard.up('KeyW');
  const tag = await p.evaluate(() => [...document.querySelectorAll('.label3d.red')].map(e => e.textContent).find(t => t?.includes('bump')));
  check('rug bump flashes the leg with the measured height', !!flash && Math.abs(flash.h - 0.015) < 0.002 && tag === '1.5 cm bump',
    flash ? `leg at (${flash.x.toFixed(2)}, ${flash.y.toFixed(2)}) h=${(flash.h * 100).toFixed(2)} cm, label "${tag}"` : 'no leg flashed');

  // 1a. 5 mm cable: classified as thin, shown with the typical height labelled estimated (not a measurement)
  await G(p, 'game.setFree(2.6, 0.5, 0)');
  await p.keyboard.down('KeyW');
  const cab = await p.waitForFunction(() => (window as any).game.state.legs.find((l: any) => l.flash && l.est), null, { timeout: 15000 }).then(h => h.jsonValue()).catch(() => null);
  await shot(p, 'hazard_cable_estimated');
  await p.keyboard.up('KeyW');
  const ctag = await p.evaluate(() => [...document.querySelectorAll('.label3d.red')].map(e => e.textContent).find(t => t?.includes('cable')));
  const clist = await p.evaluate(() => document.querySelector('#hazards')?.textContent ?? '');
  check('cable classified as thin, height shown as estimated', !!cab && /estimated/.test(ctag ?? '') && /ESTIMATED/.test(clist),
    cab ? `leg at (${cab.x.toFixed(2)}, ${cab.y.toFixed(2)}), label "${ctag}"; hazard list mentions ESTIMATED: ${/ESTIMATED/.test(clist)}` : 'no leg flashed on the cable');

  // 1b. walker frame in the 0.80 m doorway: side clearance under the margin turns it red with the gap in cm
  await G(p, 'game.setFree(3.6, 1.5, 0)');
  await p.waitForTimeout(300);
  const st = await G(p, 'return { red: game.state.red, gap: game.state.gap }');
  await shot(p, 'hazard_doorway_red_frame');
  const gapTxt = await p.evaluate(() => [...document.querySelectorAll('.label3d.red')].map(e => e.textContent).find(t => t?.endsWith('gap')));
  check('frame turns red below the clearance margin (doorway)', st.red && st.gap > 0 && st.gap < 0.10 && gapTxt === `${Math.round(st.gap * 100)} cm gap`,
    `gap ${(st.gap * 100).toFixed(1)} cm (margin 10 cm), red=${st.red}, label "${gapTxt}"`);

  // 1c. free walk is fenced: into a wall, and into floor the capture never saw (far end of the bathroom)
  const walkInto = async (x: number, y: number, yaw: number) => {
    await G(p, `game.setFree(${x}, ${y}, ${yaw})`);
    await p.keyboard.down('KeyW'); await p.waitForTimeout(5000); await p.keyboard.up('KeyW');
    return G(p, 'return { x: game.body.x, y: game.body.y, ...game.cell(game.body.x, game.body.y) }');
  };
  const wallStop = await walkInto(3.0, 2.6, Math.PI / 2), covStop = await walkInto(5.0, 0.7, 0);   // below the open door leaf, which hides y > 1.9 from the bedroom cameras
  check('free walk stays on covered floor (walls, unseen floor)', wallStop.y < 3.3 && wallStop.floor && !wallStop.obst && covStop.cov > 0 && covStop.x < 6.2,
    `toward wall y=4.0: stopped at y=${wallStop.y.toFixed(2)} (front legs need 0.75 m); toward unseen x>6.2: stopped at x=${covStop.x.toFixed(2)} (coverage ${covStop.cov} views)`);

  // 2. fill shows only after a move; moving the bed replans within ~1 s and changes route + numbers; walls reject
  // overview from high behind the walker: route + ghost walkers (red = a rollout's toe contact)
  await G(p, "game.setFree(1.0, 1.5, 0); Object.assign(game.view, { third: true, back: 2.5, up: 3.5 })");
  await p.waitForTimeout(800);
  await shot(p, 'ghost_walkers_overview');
  await G(p, "Object.assign(game.view, { third: false, back: 1.6, up: 0.9 })");
  const fillBefore = await G(p, "return game.fillVisible('bed')");
  const mv = await G(p, "return game.moveObject('bed', 2.0, 1.0, 90)");
  await p.waitForTimeout(300);
  const after = await G(p, "return { pm: game.current().per_month, len: game.current().length_m, err: game.current().error, fill: game.fillVisible('bed'), rug: game.fillVisible('rug') }");
  check('fill appears only after the object moves', fillBefore === false && after.fill === true && after.rug === false,
    `bed fill before=${fillBefore}, after=${after.fill}; unmoved rug fill=${after.rug}`);
  check('moving the bed updates route and numbers within ~1 s', mv.ok && mv.ms < 1000 && !after.err && (Math.abs(after.len - base.len) > 0.01 || Math.abs(after.pm - base.pm) > 0.01),
    `replan ${mv.ms?.toFixed(0)} ms; route ${base.len.toFixed(2)} -> ${after.len?.toFixed(2)} m; contacts/month ${base.pm.toFixed(2)} -> ${after.pm?.toFixed(2)}`);
  const wall = await G(p, "return game.moveObject('bed', 4.0, 2.6, 0)");
  check('placement into a wall is blocked', wall.ok === false, `moveObject(bed, 4.0, 2.6) -> ok=${wall.ok}`);
  await G(p, "game.select('bed')");
  await p.keyboard.press('Delete');
  await p.waitForTimeout(500);
  const rm = await G(p, "const k = game.items.indexOf('bed'), q = game.layout().poses[k]; return { removed: !!q.removed, obst: game.cell(2.0, 1.0).obst, err: game.current().error }");
  check('Delete removes the selected object from the map', rm.removed && rm.obst === 0 && !rm.err, `removed=${rm.removed}, obstacle at old spot=${rm.obst}, replan error=${rm.err}`);
  await p.click('#reset');
  await p.waitForTimeout(500);

  // 3. plan fixes: ranked by reduction, applying the top one lowers the number
  await p.click('#planfixes');
  const fixes = await p.waitForFunction(() => (window as any).game.fixes, null, { timeout: 20000 }).then(h => h.jsonValue());
  const sorted = fixes.every((f: any, i: number) => i === 0 || fixes[i - 1].reduction >= f.reduction);
  const pm0 = await G(p, 'return game.current().per_month');
  await G(p, `await game.applyFix('${fixes[0].id}')`);
  await p.waitForTimeout(500);
  const pm1 = await G(p, 'return game.current().per_month');
  check('plan fixes ranked; applying the top fix lowers risk', sorted && fixes[0].reduction > 0 && pm1 < pm0,
    fixes.map((f: any) => `${f.id} -${f.reduction === null || !isFinite(f.reduction) ? 'blocked' : f.reduction.toFixed(2)}`).join(', ') + `; applied ${fixes[0].id}: ${pm0.toFixed(2)} -> ${pm1.toFixed(2)}/month`);
  await p.click('#reset');
  await p.waitForTimeout(500);

  // 4. night mode
  await p.click('#night');
  await p.waitForTimeout(4000);
  const nfps = await G(p, 'return game.fps');
  await shot(p, 'night_mode');
  check('night mode toggles without errors', errors.length === 0, `${nfps.toFixed(1)} fps at night; page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  await p.click('#night');

  // 5. export for Cosmos: whole route at 16 fps, 93-frame chunks, one walker depth frame per camera
  await G(p, "game.setFree(2.25, 2.7, 0)");
  const job = await G(p, 'return await game.exportForCosmos()');
  const ex = await G(p, 'return game.lastExport');
  const dir = `${ROOT}viewer/public/exports/${job}`;
  const pngs = existsSync(`${dir}/walker`) ? readdirSync(`${dir}/walker`).length : 0;
  check('export for Cosmos', ex.frames % 93 === 0 && ex.chunks === ex.frames / 93 && pngs === ex.frames && existsSync(`${dir}/cosmos_job.json`) && ex.walkerPx > 0.02,
    `${job}: ${ex.frames} frames, ${ex.chunks} chunks, ${pngs} walker depth PNGs, walker covers ${(100 * ex.walkerPx).toFixed(1)}% of frame 0`);

  // 6. clip overlay alignment: synthetic clip with dots at the PYTHON projection + frame number bits
  const mk = spawnSync(PYTHON, [`${ROOT}tests/make_test_clip.py`, dir], { encoding: 'utf8' });
  if (mk.status !== 0) throw new Error(`make_test_clip failed: ${mk.stderr}`);
  const align = await G(p, `
    const clip = (await fetch('/api/clips').then(r => r.json())).find(c => c.file === 'test_${job}.mp4');
    const t = clip.test, busy = Object.keys(t.expected).filter(k => t.expected[k].length).map(Number);
    const picks = [busy[0], busy[Math.floor(busy.length / 2)], busy[busy.length - 1]];
    const video = game.openClip(clip);
    await new Promise(r => video.readyState >= 1 ? r() : video.addEventListener('loadedmetadata', r, { once: true }));
    video.pause();
    const cv = document.createElement('canvas'); cv.width = clip.width; cv.height = clip.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const out = [];
    for (const k of picks) {
      await new Promise(r => { video.addEventListener('seeked', r, { once: true }); video.currentTime = (k + 0.5) / clip.fps; });
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      ctx.drawImage(video, 0, 0);
      let shown = 0;
      for (let b = 0; b < t.bits; b++) if (ctx.getImageData(8 + t.bit_px * b + 7, t.bit_y + 7, 1, 1).data[0] > 128) shown |= 1 << b;
      const ov = game.overlay, err = [];
      for (const [x, y, label] of t.expected[k]) {
        const m = ov.markers.find(m => m.label === label);
        const px = m ? ctx.getImageData(Math.min(clip.width - 1, Math.round(m.x)), Math.min(clip.height - 1, Math.round(m.y)), 1, 1).data : null;
        err.push(m ? { d: Math.hypot(m.x - x, m.y - y), green: px[1] > 180 && px[0] < 120 } : { d: Infinity, green: false });
      }
      out.push({ k, shown, overlay: ov.frame, err });
    }
    return out;`);
  const ok = align.every((a: any) => a.shown === a.k && a.overlay === a.k && a.err.every((e: any) => e.d < 1 && e.green));
  check('clip overlay markers align at known frames', ok, align.map((a: any) =>
    `frame ${a.k}: video shows ${a.shown}, overlay ${a.overlay}, max err ${Math.max(...a.err.map((e: any) => e.d)).toFixed(2)} px, on dot ${a.err.every((e: any) => e.green)}`).join('; '));
  await p.close();
  // test artefacts would otherwise pile up in the game's clip list
  for (const f of [`${ROOT}viewer/public/clips/test_${job}.mp4`, `${ROOT}viewer/public/clips/test_${job}.json`, dir]) rmSync(f, { recursive: true, force: true });

  // 7. a doorway narrower than the walker blocks the route
  const n = await open('game_synth_narrow');
  await n.p.waitForTimeout(1000);
  const status = await n.p.textContent('#status');
  check('doorway narrower than the walker blocks the route', /^No route/.test(status ?? ''), `status: "${status}"`);
  await n.p.close();

  // 8. the newer layers on the synthetic scene
  const q = await open('game_synth');
  const Q = (f: string) => G(q.p, f);
  const r0 = await Q('return { pm: game.current().per_month, lo: game.current().per_month_lo, hi: game.current().per_month_hi, routes: game.current().routes.length, checks: game.current().checks.length }');
  check('risk range, routes and checks', r0.lo <= r0.pm && r0.pm <= r0.hi && r0.routes >= 2 && r0.checks >= 4, JSON.stringify(r0));
  const pk = await Q("await game.setPersona('parkinsons'); const a = game.current().per_month; await game.setPersona('patient'); return { a, b: game.current().per_month }");
  check('persona switch re-plans (Parkinson\'s > patient)', pk.a > pk.b, `${pk.a.toFixed(2)} vs ${pk.b.toFixed(2)}`);
  const px = async () => q.p.evaluate(() => { const c = document.querySelector('#view canvas') as HTMLCanvasElement; return c.toDataURL('image/jpeg', 0.5).length; });
  await Q('game.setVision("normal")'); await q.p.waitForTimeout(300); const n0 = await px();
  await Q('game.setVision("cataract")'); await q.p.waitForTimeout(300); const n1 = await px();
  await Q('game.setVision("normal")');
  check('vision pass changes the frame (cataract blurs: smaller JPEG)', n1 < n0 * 0.95, `${n0} -> ${n1} bytes`);
  await q.p.click('#heat'); await q.p.waitForTimeout(800);
  const heat = await Q('return !!game.current().heat');
  await q.p.click('#heat');
  check('heatmap: rollouts return per-cell counts when on', heat, String(heat));
  const t0 = Date.now();
  const opts = await Q('const o = await game.suggest(); return o.map(x => ({ n: x.name, pm: x.per_month, f: x.checks_failed }))');
  const pmNow = await Q('return game.current().per_month');
  await Q('await game.applyOption(game.suggestions.length - 1)');
  const applied = await Q('return { pm: game.current().per_month, err: game.current().error, key: game.layoutKey() }');
  check('suggest layouts, apply the full option, walkable', opts.length >= 2 && !applied.err && applied.pm <= pmNow + 1e-9 && applied.key !== 'original',
    `${opts.map((o: any) => `${o.n} ${o.pm.toFixed(2)}`).join(', ')} in ${((Date.now() - t0) / 1000).toFixed(1)} s; now ${applied.pm.toFixed(2)} (${applied.key.slice(0, 60)})`);
  const [rep] = await Promise.all([q.p.context().waitForEvent('page'), Q('game.openReport()')]);
  await rep.waitForLoadState('networkidle');
  const repText = await rep.textContent('body');
  check('OT report renders the live layout', /Expected toe contacts/.test(repText ?? '') && /Changes in this layout/.test(repText ?? '') && (await rep.$$('img')).length >= 2,
    `${(repText ?? '').length} chars`);
  await rep.close();
  const url = await Q('return await game.openFixCard()');
  const card = await browser.newPage({ viewport: { width: 390, height: 900 } });   // a phone
  await card.goto(url.replace(/^https?:\/\/[^/]+/, BASE));
  await card.waitForSelector('#list li', { timeout: 20000 });
  const items = await card.$$eval('#list li', l => l.length);
  check('fix card opens from the QR link with numbered fixes', items >= 3, `${items} items, url ${url.length} chars`);
  await card.close();
  await Q("document.getElementById('third').click(); game.setAuto()");
  await q.p.waitForTimeout(1500);
  check('third person: mannequin walks the simulated footsteps', await Q('return game.mannequinVisible() && game.heroSteps().length > 4'), 'visible with footsteps');
  const ph = await Q(`const r = await game.physicsPass(); return { done: r.every(x => x.done), snags: r.reduce((n, x) => n + x.snags.length, 0),
    li: document.querySelectorAll('#snags li').length, ms: Math.round(r.reduce((n, x) => n + x.ms, 0)) }`);
  check('physics pass (Rapier): the walker reaches every goal, snags listed', ph.done && ph.li >= 2, JSON.stringify(ph));
  await q.p.close();
  const x = await open('game_synth&xr=1');
  check('?xr=1 loads (VR button, render loop on the renderer)', await G(x.p, 'return game.xr()') && !!(await x.p.$('#vrbutton')) && x.errors.length === 0,
    `errors: ${x.errors.join('; ') || 'none'}`);
  await x.p.close();
} finally {
  await browser.close();
  writeFileSync(new URL('results.json', import.meta.url), JSON.stringify(results, null, 1));
}
process.exit(results.length && results.every(r => r.pass) ? 0 : 1);
