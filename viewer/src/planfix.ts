// Kitchen planner in the viewer: "Plan fixes" replays the offline B200 search (planner/search.py -> public/planner/<scene>/
// search.json): objects glide through the featured chain's accepted moves, each move shows a fan of 12 imagined trips,
// the risk-vs-effort chart fills with every layout searched up to that step, and a card shows the real job. It ends on
// the chosen layout (before/after) with the Pareto options. Live mode: after a judge edits the room, the critic searches
// thousands of layouts seeded with theirs and the top 5 are confirmed with real rollouts (planworker.ts).
import * as THREE from 'three';
import { fromLayout, toLayout, changed, cost, type PlanLayout, type PlannerCfg } from './planner.ts';
import { card, poseAt } from './reimagine.ts';
import type { Init } from './evaluate.ts';
import type { WorldModel } from './worldmodel.ts';
import type { Layout, Pose } from './grid.ts';

const cfgs = import.meta.glob('../../configs/planner/*.json', { eager: true, import: 'default' });

type Slim = { risk: number; lo: number; hi: number; contacts: number; snags: number; brushes: number; error?: string };
interface Search {
  scene: string; cfg: PlannerCfg & { search: any }; stats: Record<string, any>;
  scanned: { layout: PlanLayout; score: Slim; confirm: Slim | null };
  replay: { step: number; layout: PlanLayout; cost: { effort: number; usd: number }; score: Slim; ghosts: { pts: number[][]; hit: boolean[] }[] }[];
  dots: [number, number, number, number][];   // risk, effort, $, step first seen
  pareto: { layout: PlanLayout; cost: { effort: number; usd: number; minutes: number }; search: Slim; confirm: Slim }[];
  n_front?: number;   // pareto = the main front, then (search.py fronts()) the front of the layouts that keep the mat
  options: { why: string; k: number }[];   // Easiest / Keep my mat / Safest
  options_keep_mat?: { why: string; k: number }[];   // Easiest / Safest with the mat kept: the "Keep my mat" toggle
}
export interface PlanFixDeps {
  run: string; scene: THREE.Scene; init: () => Init; base: Pose[]; walker: () => { width_m: number; depth_m: number; leg_radius_m: number };
  layout: () => Layout; show: (lay: Layout) => void; commit: (lay: Layout, applied: string[]) => Promise<unknown>;
}
const $ = (id: string) => document.getElementById(id)!;
const f1 = (x: number) => x.toFixed(1);
// the headline is expected toe catches/month (score().contacts = sim.ts's calculation, the viewer's and the OT report's
// number); the search objective (risk = toe catches + simulated snags + brushes, what the B200 job minimised) stays secondary
const range = (s: Slim) => `${f1(s.contacts)} toe catches`;
const parts = (s: Slim) => `<small>tie-breakers (simulated object events, not toe catches): ${f1(s.snags)} snags + ${f1(s.brushes)} brushes/month</small>`;

export function createPlanFix(D: PlanFixDeps) {
  let data: Search | null = null, critic: any = null, playing = false, frame = -1, live: any = null;
  const fan = new THREE.Group();
  fan.renderOrder = 3;
  D.scene.add(fan);
  const url = (f: string) => `${import.meta.env.BASE_URL}planner/${D.run}/${f}`;
  const ready = Promise.all([fetch(url('search.json')).then(r => (r.ok ? r.json() : null)), fetch(url('critic.json')).then(r => (r.ok ? r.json() : null))])
    .then(([s, c]) => { data = s; critic = c; $('pfstats').innerHTML = s ? statsCard(s) : 'no planner search for this scene (planner/search.py)'; draw(); })
    .catch(() => { $('pfstats').textContent = 'no planner search for this scene (planner/search.py)'; });
  let seq = 0;
  const waiting = new Map<number, (d: any) => void>(), workers: Record<string, Worker> = {};
  /** 'pop' scores with the scene's world model; 'me' is restarted by replanFor with one person's (gaitfit.ts) */
  function ask(msg: object, who = 'pop', wm?: WorldModel) {
    if (!workers[who]) {
      const w = workers[who] = new Worker(new URL('./planworker.ts', import.meta.url), { type: 'module' });
      w.onmessage = e => { waiting.get(e.data.id)?.(e.data); waiting.delete(e.data.id); };
      w.postMessage({ type: 'init', init: wm ? { ...D.init(), worldModel: wm } : D.init(), cfg: cfg(), base: D.base, walker: D.walker(), critic });
    }
    return new Promise<any>(res => { const id = ++seq; waiting.set(id, res); workers[who].postMessage({ ...msg, id }); });
  }
  // fix options from configs/planner/<scene>.json over the search's frozen copy: a fix added since the B200 search shows up
  // in the live planner and the OT report without re-running it (the replayed search never proposes it)
  const own = (cfgs[`../../configs/planner/${D.run}.json`] as { options?: PlannerCfg['options'] } | undefined)?.options;
  const S = () => D.init(), cfg = (): PlannerCfg => (own ? { ...data!.cfg, options: { ...data!.cfg.options, ...own } } : data!.cfg);
  const keepMat = () => ($('pfkeepmat') as HTMLInputElement).checked && !!data?.options_keep_mat?.length;
  /** the options on show: the "Keep my mat" toggle swaps in the ones that keep it */
  const opts = () => (keepMat() ? data!.options_keep_mat! : data!.options);
  $('pfkeepmat').addEventListener('change', () => { if (data && !playing && $('pfoptions').children.length) apply(opts()[0].k); else draw(); });
  /** the configured fixes a planner layout uses, for the receipt (reimagine.ts labels them) */
  const fixesOf = (pl: PlanLayout) => [cfg().options.mat[pl.mat], cfg().options.cord[pl.cord], cfg().options.nightlight[pl.nightlight]]
    .flatMap(o => (o && 'from_fix' in o ? [o.from_fix] : []));

  function statsCard(s: Search) {
    const t = s.stats, n = (x: number) => x.toLocaleString('en-US');
    return `<b>${n(t.layouts_searched)}</b> layouts searched · <b>${n(t.trips_imagined)}</b> trips imagined (${n(t.footsteps_imagined)} footsteps)<br>` +
      `${t.chains} annealing chains × ${t.steps} steps · ${n(t.evaluations)} proposals · ${Math.round(t.runtime_s / 60)} min on ${t.gpu}` +
      ` (rollouts ${Math.round(t.gpu_rollout_s)} s GPU)${t.slurm_job ? ` · Slurm job ${t.slurm_job}` : ''}`;
  }

  // ---- chart: every layout searched, risk (y) against effort (x); the Pareto front and options once the replay ends
  function draw() {
    const cv = $('pfchart') as HTMLCanvasElement, c = cv.getContext('2d')!, W = cv.width, H = cv.height, P = 26;
    c.clearRect(0, 0, W, H);
    if (!data) return;
    const step = frame < 0 ? -1 : playing ? data.replay[frame].step : Infinity;
    const ds = data.dots, rmax = Math.max(...ds.map(d => d[0])), emax = Math.max(...ds.map(d => d[1]), 1);
    const X = (e: number) => P + (e / emax) * (W - P - 6), Y = (r: number) => H - P - (r / rmax) * (H - P - 6);
    c.strokeStyle = '#3a4048'; c.beginPath(); c.moveTo(P, 4); c.lineTo(P, H - P); c.lineTo(W - 4, H - P); c.stroke();
    c.fillStyle = '#9aa0a6'; c.font = '10px system-ui';
    c.fillText('effort →', W - 46, H - P + 14); c.fillText('0', P - 8, H - P + 10);
    c.save(); c.translate(10, H / 2 + 30); c.rotate(-Math.PI / 2); c.fillText('search objective / month →', 0, 0); c.restore();
    c.fillText(f1(rmax), 2, 12);
    c.fillStyle = 'rgba(77,201,240,0.35)';
    for (const d of ds) if (d[3] <= step) c.fillRect(X(d[1]) - 1, Y(d[0]) - 1, 2, 2);
    const ring = (e: number, r: number, col: string, rad = 5) => { c.strokeStyle = col; c.lineWidth = 2; c.beginPath(); c.arc(X(e), Y(r), rad, 0, 7); c.stroke(); c.lineWidth = 1; };
    if (frame >= 0 && playing) { const f = data.replay[frame]; ring(f.cost.effort, f.score.risk, '#ffe14d'); }
    if (step === Infinity) {
      const n = data.n_front ?? data.pareto.length;
      c.strokeStyle = '#6fd08c'; c.beginPath();
      (keepMat() ? data.pareto.slice(n) : data.pareto.slice(0, n)).forEach((p, k) => (k ? c.lineTo : c.moveTo).call(c, X(p.cost.effort), Y(p.confirm.risk)));
      c.stroke();
      opts().forEach(o => ring(data!.pareto[o.k].cost.effort, data!.pareto[o.k].confirm.risk, '#6fd08c', 6));
    }
    if (live && !live.invalid.length) ring(0, live.judge.s.risk, '#e070ff', 6);   // live mode: effort is counted from the judge's layout
    if (live) ring(live.best.effort, live.best.s.risk, '#ffffff', 4);
  }

  // ---- fan of futures: the frame's 12 imagined trips, footsteps joined, contacts red
  function showFan(gs: { pts: number[][]; hit: boolean[] }[]) {
    for (const o of [...fan.children]) { fan.remove(o); if (o instanceof THREE.Sprite) o.material.dispose(); else (o as THREE.Line).geometry.dispose(); }
    // life-size in the kitchen, not only the side chart: each imagined trip's heel strikes, green clean / red if it caught a toe
    gs.forEach((g, n) => {
      const z = 0.03 + n * 0.0005, bad = g.hit.some(h => h), col = bad ? 0xff3030 : 0x3ddc84;
      const v = g.pts.map(p => new THREE.Vector3(p[0], p[1], z));
      fan.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(v), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.7, depthTest: false })));
      fan.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(v), new THREE.PointsMaterial({ color: col, size: bad ? 0.07 : 0.045, transparent: true, opacity: 0.85, depthTest: false })));
    });
    const mid = gs[0]?.pts[Math.floor(gs[0].pts.length / 2)];
    if (mid) {
      const n = gs.filter(g => g.hit.some(h => h)).length, tag = card([`imagined (world model): ${gs.length} trips in this layout`, `${n} caught a toe · green = clean`], '#bff3d4');
      tag.position.set(mid[0], mid[1], 1.9); tag.renderOrder = 4; fan.add(tag);
    }
  }

  /** glide the room's objects from one planner layout to the next (visual only; no re-plan until the end) */
  function glide(a: PlanLayout, b: PlanLayout, ms: number) {
    const la = toLayout(S(), cfg(), D.base, a), lb = toLayout(S(), cfg(), D.base, b), t0 = performance.now();
    return new Promise<void>(res => {
      const tick = () => {
        const t = Math.min(1, (performance.now() - t0) / ms);
        D.show({ poses: la.poses.map((p, k) => (t < 1 ? { ...poseAt(p, lb.poses[k], t), removed: t < 0.5 ? p.removed : lb.poses[k].removed } : lb.poses[k])), flattened: t < 0.5 ? la.flattened : lb.flattened });
        if (t < 1 && playing) requestAnimationFrame(tick); else res();
      };
      tick();
    });
  }

  /** "Plan fixes": the replay, then the chosen layout applied for real with its before/after and the options */
  async function play(seconds = 24) {
    await ready;
    if (!data || playing) return;
    playing = true; live = null;
    $('pfresult').innerHTML = ''; $('pfoptions').innerHTML = '';
    const fr = data.replay, ms = (seconds * 1000) / fr.length;
    let prev = data.scanned.layout;
    for (frame = 0; frame < fr.length && playing; frame++) {
      const f = fr[frame];
      showFan(f.ghosts); draw();
      $('pfresult').innerHTML = `step ${f.step} of ${data.stats.steps}: <b>${f1(f.score.contacts)}</b> toe catches/month · effort ${f.cost.effort.toFixed(1)} · $${f.cost.usd}`;
      await glide(prev, f.layout, ms * 0.7);
      await new Promise(r => setTimeout(r, ms * 0.3));
      prev = f.layout;
    }
    showFan([]);
    if (!playing) { frame = -1; draw(); return state(); }   // stopped (Reset demo): nothing is applied
    frame = fr.length - 1;
    playing = false;
    const chosen = opts()[0];
    await apply(chosen.k);
    draw();
    return state();
  }
  async function apply(k: number) {
    const p = data!.pareto[k], before = data!.scanned.confirm ?? data!.scanned.score;
    await glide(fromLayout(S(), cfg(), D.base, D.layout()), p.layout, 900);
    await D.commit(toLayout(S(), cfg(), D.base, p.layout), fixesOf(p.layout));
    const items = cost(S(), cfg(), data!.scanned.layout, p.layout).items;
    $('pfresult').innerHTML = `<b>Before</b>: ${range(before)}/month<br>${parts(before)}<br><b>After</b>: <span class="delta-good">${range(p.confirm)}</span>/month<br>${parts(p.confirm)}` +
      `<br><small>both re-run on fresh trips (seed ${data!.stats.confirm_seed}), not the search's own draws</small>` +
      `<ol>${items.map(i => `<li>${i.label} <small class="cost">${i.usd ? `$${i.usd} · ` : ''}${i.minutes} min${i.assumption ? ` · ${i.assumption}` : ''}</small></li>`).join('')}</ol>`;
    $('pfoptions').innerHTML = '';
    for (const o of opts()) {
      const q = data!.pareto[o.k], li = document.createElement('li'), b = document.createElement('button');
      li.innerHTML = `${o.why}: <b>${f1(q.confirm.contacts)}</b> toe catches/month · effort ${q.cost.effort.toFixed(1)} · $${q.cost.usd} · ${parts(q.confirm)} `;
      b.textContent = o.k === k ? 'Applied' : 'Apply'; b.disabled = o.k === k;
      b.onclick = () => apply(o.k);
      li.appendChild(b); $('pfoptions').appendChild(li);
    }
  }

  /** a planner value for one changed key: a chair's pose, or the mat / cord / nightlight state */
  const val = (pl: PlanLayout, key: string) => JSON.stringify(key in pl.chairs ? pl.chairs[key] : key === 'mat' ? [pl.mat, pl.mat_at] : key === 'cord' ? pl.cord : [pl.nightlight, pl.nightlight_at]);
  /** live mode: the judge's layout (the room as it is now) against the critic's search from it */
  async function improve(n = 4000) {
    await ready;
    if (!data || !critic) { $('pfresult').textContent = 'no critic for this scene (planner/critic.py)'; return null; }
    const judge = fromLayout(S(), cfg(), D.base, D.layout());
    if (($('pfmattaped') as HTMLInputElement).checked && judge.mat === 'present') judge.mat = 'taped';
    const scan = data.scanned.layout;
    $('pfresult').textContent = `critic searching ${n.toLocaleString('en-US')} layouts from yours…`;
    const r = await ask({ type: 'live', judge, scan, n });
    live = r;
    const mine = changed(cfg(), scan, judge), kept = mine.filter(k => val(r.best.pl, k) === val(judge, k));
    const same = JSON.stringify(r.best.pl) === JSON.stringify(r.invalid.length ? scan : judge);
    $('pfresult').innerHTML = (r.invalid.length ? `<div class="delta-bad">Your layout can't be used as is: ${r.invalid.join('; ')}. The search started from the scanned room instead.</div>` :
      `Your layout <b>${range(r.judge.s)}</b> → AI <b class="delta-good">${range(r.best.s)}</b>/month<br>${parts(r.best.s)}<br>`) +
      (same ? 'No layout the critic found beat yours once re-run for real: keeping it.<br>' : '') +
      (mine.length && !r.invalid.length ? `Kept ${kept.length} of your ${mine.length} change${mine.length === 1 ? '' : 's'}${kept.length ? `: ${kept.join(', ')}` : ''}` +
        `${mine.length > kept.length ? `; changed ${mine.filter(k => !kept.includes(k)).join(', ')}` : ''}<br>` : '') +
      `<small>${r.searched.toLocaleString('en-US')} layouts scored by the critic in ${(r.ms / 1000).toFixed(1)} s; yours and its top 5 re-run with ${S().risk.rollouts} real trips each (same seed)</small>`;
    const b = document.createElement('button');
    b.textContent = 'Apply AI layout'; b.disabled = same;
    b.onclick = async () => { await glide(judge, r.best.pl, 900); await D.commit(toLayout(S(), cfg(), D.base, r.best.pl), fixesOf(r.best.pl)); };
    $('pfresult').appendChild(b);
    draw();
    return { judge: r.judge.s, best: r.best.s, invalid: r.invalid, kept, changed: mine, searched: r.searched, layout: r.best.pl,
      candidates: r.candidates.map((c: any) => ({ critic: c.critic, risk: c.s.risk, effort: c.effort })) };
  }

  /** "Re-plan for me": the room as it is now (usually the planner's choice) re-run with one person's world model, then the
   *  same critic search from it, confirmed with that model. Shows which fixes change for them. */
  async function replanFor(wm: WorldModel, who: string, n = 3000, popWm?: WorldModel) {
    await ready;
    if (!data || !critic) return null;
    workers.me?.terminate(); delete workers.me; workers.mepop?.terminate(); delete workers.mepop;
    const cur = fromLayout(S(), cfg(), D.base, D.layout());
    $('pfresult').textContent = `re-planning with ${who}'s gait…`;
    const [{ scores: [pop] }, r] = await Promise.all([(popWm ? ask({ type: 'score', pls: [cur] }, 'mepop', popWm) : ask({ type: 'score', pls: [cur] })), ask({ type: 'live', judge: cur, scan: data.scanned.layout, n }, 'me', wm)]);
    const diff = changed(cfg(), cur, r.best.pl), same = !diff.length;
    $('pfresult').innerHTML = `<b>Re-planned for ${who}</b><br>current layout: ${range(pop)}/month for the average walker${popWm ? ' (same network, mean embedding)' : ''}, <b>${range(r.judge.s)}</b> with this gait<br>` +
      (same ? 'No layout beat the current one for this gait: the fixes stay the same.' :
        `for this gait: <b class="delta-good">${range(r.best.s)}</b>/month after changing <b>${diff.join(', ')}</b>`) +
      `<br><small>critic (trained on the average walker) proposes; ${r.searched.toLocaleString('en-US')} layouts, its top 5 re-run with this person's world model</small>`;
    const b = document.createElement('button');
    b.textContent = 'Apply re-plan'; b.disabled = same;
    b.onclick = async () => { await glide(cur, r.best.pl, 900); await D.commit(toLayout(S(), cfg(), D.base, r.best.pl), fixesOf(r.best.pl)); };
    $('pfresult').appendChild(b);
    return { current_population: pop, current_you: r.judge.s, best_you: r.best.s, changed: diff, layout: r.best.pl, searched: r.searched };
  }

  const state = () => ({ loaded: !!data, playing, frame, frames: data?.replay.length ?? 0, stats: data?.stats, options: data ? opts().map(o => ({ ...o, ...data!.pareto[o.k] })) : undefined });
  /** OT report: the planner's layout (the live search's if one ran, else the chosen option), one change at a time on the
   *  room as it is now, each scored for real and ranked by toe catches removed (the search objective breaks ties). null =
   *  no planner search for this scene. */
  async function rankedFixes() {
    await ready;
    if (!data) return null;
    const cur = fromLayout(S(), cfg(), D.base, D.layout()), goal: PlanLayout = live?.best.pl ?? data.pareto[opts()[0].k].layout;
    const one = (k: string) => {
      const q = structuredClone(cur);
      if (k in q.chairs) q.chairs[k] = goal.chairs[k];
      else if (k === 'mat') { q.mat = goal.mat; q.mat_at = goal.mat_at; }
      else if (k === 'cord') q.cord = goal.cord;
      else if (k === 'caps') q.caps = goal.caps;
      else { q.nightlight = goal.nightlight; q.nightlight_at = goal.nightlight_at; }
      return q;
    };
    const pls = changed(cfg(), cur, goal).map(one);
    // taping the rug's edge always ranks next to the search's picks (glide caps stay hidden: their friction is ASSUMED)
    if (cur.mat === 'present' && !pls.some(p => p.mat === 'taped')) pls.push({ ...cur, mat: 'taped' });
    const { scores } = await ask({ type: 'score', pls: [cur, ...pls] }), before = scores[0].contacts;
    return pls.map((pl, n) => ({ pl, n })).filter(({ pl, n }) => changed(cfg(), cur, pl)[0] !== 'nightlight' || scores[n + 1].check.length || before - scores[n + 1].contacts > 0)   // a nightlight change that saves nothing isn't a fix
      .map(({ pl, n }) => {
      const it = cost(S(), cfg(), cur, pl).items[0], sc = scores[n + 1], cut = before - sc.contacts;
      return { label: it?.label ?? changed(cfg(), cur, pl)[0], error: sc.check.length ? sc.check.join('; ') : sc.error, reduction: Math.max(0, cut), share: before > 0 ? cut / before : 0,
        objective_cut: scores[0].risk - sc.risk, clearance_gain_m: 0, cost_usd: it?.usd, minutes: it?.minutes, effort: it?.effort };
    }).sort((a, b) => (+!!a.error - +!!b.error) || (b.reduction - a.reduction) || (b.objective_cut - a.objective_cut));
  }
  /** OT report: the options on show (Easiest / Keep my mat / Safest), each confirmed on fresh trips; null = no planner search */
  const optionsOut = () => (data ? opts().map(o => { const q = data!.pareto[o.k];
    return { name: o.why, per_month: q.confirm.contacts, cost_usd: q.cost.usd, minutes: q.cost.minutes, effort: q.cost.effort,
      changes: cost(S(), cfg(), data!.scanned.layout, q.layout).items.map(i => i.label) }; }) : null);
  /** wmghosts.ts: the room as it is now / the scan / the chosen option, the evaluator's trips with one world model, and a
   *  glide + commit to a planner layout (before / after) */
  const layouts = () => (data ? { now: fromLayout(S(), cfg(), D.base, D.layout()), scan: data.scanned.layout, chosen: data.pareto[opts()[0].k].layout } : null);
  const imagine = (pl: PlanLayout, wm: WorldModel, n: number, nf = 0) => ready.then(() => ask({ type: 'imagine', pl, wm, n, nf }));
  async function goto(pl: PlanLayout) { await glide(fromLayout(S(), cfg(), D.base, D.layout()), pl, 900); await D.commit(toLayout(S(), cfg(), D.base, pl), fixesOf(pl)); }
  return { ready, play, apply, improve, replanFor, rankedFixes, optionsOut, stop: () => { playing = false; }, state, score: (pls: PlanLayout[]) => ask({ type: 'score', pls }).then(r => r.scores),
    layouts, imagine, goto };
}
