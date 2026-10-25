// The reach map in the room (reach.ts). It draws:
// - the floor painted where the device can go;
// - a wave spreading from the route's start;
// - a ghost path to every target, all leaving the start together and stopping where the device can't pass;
// - tags naming what stops it.
// Scene objects only (a floor plane, points, rings, card sprites), so it shows in the headset too.
import * as THREE from 'three';
import type { GridMeta, XY } from './grid.ts';
import { CLS, causeText, type CostStep, type ReachReport, type TargetOut } from './reach.ts';
import { card } from './reimagine.ts';

/** floor colours (sRGB, alpha): green reachable, amber tight (OT to verify), red cut off, grey unscanned */
const RGBA: Record<number, [number, number, number, number]> = {
  [CLS.ok]: [46, 204, 113, 100], [CLS.tight]: [255, 176, 32, 150], [CLS.cut]: [235, 64, 52, 165], [CLS.grey]: [150, 155, 160, 125] };
export const STATUS_RGB: Record<TargetOut['status'], [number, number, number]> = {
  ok: [0.3, 0.88, 0.5], tight: [1, 0.72, 0.16], cut: [1, 0.3, 0.26], no_room: [0.75, 0.75, 0.8] };
const hex = (rgb: number[]) => new THREE.Color(rgb[0], rgb[1], rgb[2]);
const cm = (m: number) => `${Math.round(m * 100)} cm`;

export function createReach3d(g: GridMeta, scene: THREE.Scene) {
  const [nx, ny] = g.shape, cell = g.cell_m;
  const root = new THREE.Group();
  root.name = 'reach'; root.visible = false;
  scene.add(root);

  // the paint: one texel per grid cell (index j * nx + i, like spotlight.ts heightTexels), the wave gated in the shader
  const texture = () => {
    const t = new THREE.DataTexture(new Uint8Array(nx * ny * 4), nx, ny);
    t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
    return t;
  };
  const colour = texture(), wave = texture();
  const mat = new THREE.ShaderMaterial({
    uniforms: { colour: { value: colour }, wave: { value: wave }, uT: { value: 1 } }, transparent: true, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D colour; uniform sampler2D wave; uniform float uT; varying vec2 vUv;
      void main() {
        vec4 c = texture2D(colour, vUv);
        if (c.a < 0.01) discard;
        vec4 w = texture2D(wave, vUv);
        if (w.g > 0.5) { if (uT < 1.0) discard; }   // cut off / unscanned: shown once the wave has been everywhere it can go
        else if (w.r > uT) discard;
        float front = (w.g > 0.5 || uT >= 1.0) ? 0.0 : 1.0 - smoothstep(0.0, 0.04, uT - w.r);
        gl_FragColor = vec4(mix(c.rgb, vec3(1.0), 0.6 * front), min(1.0, c.a + 0.45 * front));
      }`,
  });
  const paint = new THREE.Mesh(new THREE.PlaneGeometry(nx * cell, ny * cell), mat);
  paint.position.set(g.origin_xy[0] + (nx * cell) / 2, g.origin_xy[1] + (ny * cell) / 2, 0.026);   // under the route line (0.035) and ghosts
  paint.renderOrder = 1; paint.name = 'reach paint';   // after the splats: they don't write depth
  root.add(paint);

  // coverage ghosts: one soft dot every 5 cm along each target's widest way, revealed by distance from the start
  const DOT = (() => { const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d')!, gr = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, '#fff'); gr.addColorStop(0.55, '#fffd'); gr.addColorStop(1, '#fff0'); x.fillStyle = gr; x.fillRect(0, 0, 32, 32); return new THREE.CanvasTexture(c); })();
  const ghosts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map: DOT, vertexColors: true, size: 6, sizeAttenuation: false, transparent: true, depthWrite: false }));
  ghosts.renderOrder = 1; ghosts.name = 'reach ghosts';
  root.add(ghosts);
  const marks = new THREE.Group();
  marks.renderOrder = 3;
  root.add(marks);

  let reveal = new Float32Array(0), maxL = 1, t = 1, dur = 0;

  /** Repaint from per-cell classes (reach.ts paintClasses); len: distance along the widest way, for the wave. */
  function setCells(cls: Uint8Array, len: Float32Array, hatch: Uint8Array) {
    const C = colour.image.data as Uint8Array, W = wave.image.data as Uint8Array;
    maxL = 1e-6;
    for (let k = 0; k < cls.length; k++) if ((cls[k] === CLS.ok || cls[k] === CLS.tight) && len[k] < Infinity) maxL = Math.max(maxL, len[k]);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const k = i * ny + j, o = (j * nx + i) * 4, c = cls[k];
      if (!c) { C[o + 3] = 0; continue; }
      const [r, gg, b, a0] = RGBA[c];
      let a = a0;
      if (c === CLS.cut && (i + j) % 10 < 4) a *= 0.4;   // stripes and dots: colour isn't the only sign (vision filter)
      if (c === CLS.tight && i % 5 === 0 && j % 5 === 0) a = 235;
      if (hatch[k] && (i + j) % 2) a *= 0.45;   // floor not measured directly: low coverage, under furniture as filmed, designed
      C[o] = r; C[o + 1] = gg; C[o + 2] = b; C[o + 3] = Math.round(a);
      const late = c === CLS.cut || c === CLS.grey;
      W[o] = late ? 0 : Math.min(255, Math.round((255 * len[k]) / maxL)); W[o + 1] = late ? 255 : 0;
    }
    colour.needsUpdate = wave.needsUpdate = true;
  }

  function clearMarks() {
    for (const c of [...marks.children]) {
      marks.remove(c);
      c.traverse(x => { const m = x as THREE.Mesh; m.geometry?.dispose(); for (const mt of [m.material].flat() as THREE.Material[]) mt?.dispose(); });   // card textures are cached, not owned
    }
  }
  const ring = (at: XY, r: number, rgb: number[], z = 0.032) => {
    const m = new THREE.Mesh(new THREE.RingGeometry(r * 0.72, r, 28), new THREE.MeshBasicMaterial({ color: hex(rgb), transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
    m.position.set(at[0], at[1], z); m.renderOrder = 2;
    marks.add(m);
  };
  const tag = (at: XY, lines: string[], color: string, z = 1.15) => { const s = card(lines.filter(Boolean), color); s.position.set(at[0], at[1], z); marks.add(s); };

  /** Ghost paths, target rings and the tags for a report. Called when the report changes, not per slider tick. */
  function setReport(r: ReachReport) {
    const dots: { p: XY; s: number; rgb: number[] }[] = [];
    for (const tg of r.targets) {
      let s = 0;
      tg.path.forEach((p, n) => { if (n) s += Math.hypot(p[0] - tg.path[n - 1][0], p[1] - tg.path[n - 1][1]); dots.push({ p, s, rgb: STATUS_RGB[tg.status] }); });
    }
    dots.sort((a, b) => a.s - b.s);
    const pos = new Float32Array(dots.length * 3), col = new Float32Array(dots.length * 3);
    reveal = new Float32Array(dots.length);
    dots.forEach((d, n) => { pos.set([d.p[0], d.p[1], 0.045], n * 3); col.set(d.rgb, n * 3); reveal[n] = d.s; });
    ghosts.geometry.dispose();
    ghosts.geometry = new THREE.BufferGeometry();
    ghosts.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    ghosts.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));

    clearMarks();
    for (const tg of r.targets) {
      if (tg.kind === 'region') continue;   // its tag says it all
      ring(tg.at, tg.kind === 'point' ? 0.17 : tg.kind === 'goal' ? 0.14 : 0.08, STATUS_RGB[tg.status]);
      if (tg.stopped && tg.path.length) ring(tg.path[tg.path.length - 1], 0.12, STATUS_RGB.cut, 0.05);
      if (tg.kind === 'point' || (tg.kind === 'goal' && tg.status !== 'ok'))
        tag(tg.at, [tg.name, statusLine(tg), tg.cause ? `by ${causeText(tg.cause)}` : ''], `#${hex(STATUS_RGB[tg.status]).getHexString()}`, 1.0);
    }
    for (const g0 of r.regions) tag(g0.at, [`Cut off · ${g0.area_m2.toFixed(1)} m²`, `by ${causeText(g0.cause)}`,
      g0.pinch ? `${cm(g0.pinch.width_m)} at the narrowest · needs ${cm(r.need_w_m)}` : 'no way in on the scan', g0.opens_if_moved ? 'moving it opens this part' : ''], '#ff8a80');
    for (const pk of r.pockets ?? []) tag(pk.at, [`Dead end · reverse ${pk.reverse_m < Infinity ? `${pk.reverse_m.toFixed(1)} m` : 'all the way'}`,
      pk.closed_by ? `far end closed by ${causeText(pk.closed_by)}` : 'no 1.5 m turning circle (ADA 304)'], '#ffcc66');
    apply();
  }

  function apply() {
    mat.uniforms.uT.value = t;
    const L = t >= 1 ? Infinity : t * maxL;
    let lo = 0, hi = reveal.length;   // dots are sorted by distance: draw the ones the wave has reached
    while (lo < hi) { const m = (lo + hi) >> 1; if (reveal[m] <= L) lo = m + 1; else hi = m; }
    ghosts.geometry.setDrawRange(0, lo);
    marks.visible = t >= 1;
  }
  return {
    root, paint, ghosts, marks, setCells, setReport,
    /** the wave from the start over `seconds`; reduced motion shows the end at once */
    play(seconds = 4, reduce = false) { if (reduce || seconds <= 0) { t = 1; dur = 0; } else { t = 0; dur = seconds; } apply(); },
    tick(dt: number) { if (t >= 1 || !dur || !root.visible) return; t = Math.min(1, t + dt / dur); apply(); },
    t: () => t,
    drawn: () => ghosts.geometry.drawRange.count === Infinity ? reveal.length : Math.min(ghosts.geometry.drawRange.count, reveal.length),
    dots: () => reveal.length,
  };
}

/** "reachable · 92 cm on the way in", "cut off at 55 cm", ... */
export function statusLine(t: TargetOut): string {
  if (t.status === 'no_room') return `the device doesn't fit here (${cm(t.width_m)} clear)`;
  if (t.status === 'ok') return `reachable · ${cm(t.width_m)} on the way in`;
  if (t.status === 'tight') return `tight: ${cm(t.pinch?.width_m ?? t.width_m)} at the narrowest (OT to verify)`;
  return `cut off: ${cm(t.pinch?.width_m ?? t.width_m)} at the narrowest${t.opens_if_moved ? ' · moving it opens the way' : ''}`;
}

/** Runs of device widths that cost the same to get through (costToReach's steps, one per cm): the chart's segments and
 *  its text view. */
export function costRuns(steps: CostStep[]) {
  const runs: { a: number; b: number; usd: number | null; label: string; source: string }[] = [];
  for (const s of steps) {
    const last = runs[runs.length - 1];
    if (last && last.usd === s.usd && last.label === s.label) last.b = s.width_m;
    else runs.push({ a: s.width_m, b: s.width_m, usd: s.usd, label: s.label, source: s.source });
  }
  return runs;
}

/** The cost to get through one doorway at each device width, as a strip along the width axis.
 *  - One ordinal blue per price tier (validated: dataviz validate_palette --ordinal, dark and light panel surfaces).
 *  - Widths no configured fix opens are hatched grey.
 *  - Prices are labelled above segments that have room; the current width is marked.
 *  A single series, so the panel's heading names it and there is no legend; the runs are listed as text below. */
export function drawCostChart(cv: HTMLCanvasElement, steps: CostStep[], current_m: number) {
  const ctx = cv.getContext('2d')!, W = cv.width, H = cv.height, m = { l: 10, r: 10, t: 20, b: 18 }, bh = 24;   // l, r: costAt's too
  const css = getComputedStyle(document.documentElement), tok = (v: string, d: string) => css.getPropertyValue(v).trim() || d;
  const text = tok('--text-2', '#d7e4ec'), muted = tok('--muted', '#a7b5c0'), grid = tok('--line', '#34424d');
  const light = (() => { const c = new THREE.Color(text); return c.r + c.g + c.b < 1.2; })();   // dark ink: the light theme
  const ramp = light ? ['#6da7ec', '#256abf', '#0d366b'] : ['#1c5cab', '#3987e5', '#9ec5f4'];
  ctx.clearRect(0, 0, W, H);
  if (!steps.length) return;
  const w0 = steps[0].width_m - 0.005, w1 = steps[steps.length - 1].width_m + 0.005, X = (w: number) => m.l + ((w - w0) / (w1 - w0)) * (W - m.l - m.r);
  const runs = costRuns(steps), prices = runs.map(r => r.usd).filter((u): u is number => u !== null);
  const lo = Math.min(...prices), hi = Math.max(...prices), tier = (u: number) => (u === lo ? 0 : u === hi ? 2 : 1);
  ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  for (const r of runs) {
    const x0 = X(r.a - 0.005) + 1, x1 = X(r.b + 0.005) - 1, y = m.t;   // 2px surface gap between segments
    if (x1 <= x0) continue;
    if (r.usd === null) {   // nothing configured opens it this wide: hatched, not a price
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y, x1 - x0, bh); ctx.clip();
      ctx.strokeStyle = muted; ctx.lineWidth = 1;
      for (let x = x0 - bh; x < x1; x += 6) { ctx.beginPath(); ctx.moveTo(x, y + bh); ctx.lineTo(x + bh, y); ctx.stroke(); }
      ctx.restore();
    } else { ctx.fillStyle = ramp[tier(r.usd)]; ctx.beginPath(); ctx.roundRect(x0, y, x1 - x0, bh, 4); ctx.fill(); }
    const lab = r.usd === null ? 'no fix' : `$${r.usd.toLocaleString()}`;
    if (ctx.measureText(lab).width + 6 < x1 - x0) { ctx.fillStyle = text; ctx.fillText(lab, (x0 + x1) / 2, y - 6); }
  }
  // width axis: a hairline and a tick every 10 cm
  ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(m.l, m.t + bh + 3.5); ctx.lineTo(W - m.r, m.t + bh + 3.5); ctx.stroke();
  ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = muted;
  for (let c = Math.ceil(w0 * 10) / 10, first = true; c <= w1 - 0.04; c += 0.1, first = false) ctx.fillText(`${Math.round(c * 100)}${first ? ' cm' : ''}`, X(c), H - 4);
  // this device's width
  if (current_m >= w0 && current_m <= w1) {
    const x = Math.round(X(current_m)) + 0.5;
    ctx.strokeStyle = text; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, m.t - 3); ctx.lineTo(x, m.t + bh + 6); ctx.stroke();
  }
}
/** The step under canvas x (the same width axis as drawCostChart): its hover text. */
export function costAt(cv: HTMLCanvasElement, steps: CostStep[], x: number): CostStep | null {
  if (!steps.length) return null;
  const w0 = steps[0].width_m - 0.005, w1 = steps[steps.length - 1].width_m + 0.005, w = w0 + ((x - 10) / (cv.width - 20)) * (w1 - w0);
  return steps.reduce((b, s) => (Math.abs(s.width_m - w) < Math.abs(b.width_m - w) ? s : b));
}
