// Where the simulated nights go wrong, at a glance: a floor heatmap of the rollouts (cyan = where feet land, orange to red =
// expected toe contacts) and a 30-night strip drawn from the current rate (one Poisson draw per night, fixed seed).
import * as THREE from 'three';
import type { GridMeta } from './grid.ts';
import type { Heat } from './sim.ts';
import { rng } from './sim.ts';

export function createHeatOverlay(g: GridMeta, scene: THREE.Scene) {
  const [nx, ny] = g.shape, cv = document.createElement('canvas');
  cv.width = nx; cv.height = ny;
  const ctx = cv.getContext('2d')!, img = ctx.createImageData(nx, ny), tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.LinearFilter;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(nx * g.cell_m, ny * g.cell_m),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  mesh.position.set(g.origin_xy[0] + (nx * g.cell_m) / 2, g.origin_xy[1] + (ny * g.cell_m) / 2, 0.028);
  mesh.renderOrder = 1;
  mesh.visible = false;
  scene.add(mesh);
  return {
    mesh,
    update(h: Heat) {
      // blur by one cell so single footsteps read as a band, not speckle
      const blur = (a: Float32Array) => {
        const o = new Float32Array(a.length);
        for (let i = 1; i < nx - 1; i++) for (let j = 1; j < ny - 1; j++) {
          let s = 0;
          for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) s += a[(i + di) * ny + j + dj];
          o[i * ny + j] = s / 9;
        }
        return o;
      };
      const st = blur(h.steps), hi = blur(h.hits);
      let ms = 0, mh = 0;
      for (let k = 0; k < st.length; k++) { ms = Math.max(ms, st[k]); mh = Math.max(mh, hi[k]); }
      img.data.fill(0);
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const k = i * ny + j, p = ((ny - 1 - j) * nx + i) * 4;
        const a = ms ? Math.sqrt(st[k] / ms) : 0, r = mh ? Math.sqrt(hi[k] / mh) : 0;
        // the viewer's palette: contacts orange (bump rings) -> red (leg flash), footsteps cyan (ghosts)
        if (r > 0.25) img.data.set([255, Math.round(138 - 90 * r), Math.round(31 + 17 * r), Math.round(255 * Math.min(1, 1.6 * (r - 0.25) + 0.35))], p);   // only the hot spots glow
        else if (a > 0.05) img.data.set([76, 201, 240, Math.round(160 * a)], p);
      }
      ctx.putImageData(img, 0, 0);
      tex.needsUpdate = true;
    },
  };
}

/** 30 nights from a monthly rate: counts per night (Poisson, Knuth) and which hazard each contact is at. */
export function nights(perMonth: number, shares: { name: string; per_month: number }[], seed = 7, days = 30) {
  const R = rng(seed), lam = perMonth / days, total = shares.reduce((a, s) => a + s.per_month, 0);
  return Array.from({ length: days }, () => {
    let k = 0, p = 1;
    const L = Math.exp(-lam);
    for (;;) { p *= R.u(); if (p <= L) break; k++; }
    const at: string[] = [];
    for (let n = 0; n < k; n++) {   // attribute each contact to a hazard in proportion to its share
      let u = R.u() * total;
      at.push(shares.find(s => (u -= s.per_month) <= 0)?.name ?? shares.at(-1)?.name ?? 'a bump');
    }
    return { count: k, at };
  });
}

export function drawTimeline(cv: HTMLCanvasElement, data: { count: number }[], sel: number) {
  const W = cv.width, H = cv.height, c = cv.getContext('2d')!, bw = W / data.length, max = Math.max(2, ...data.map(d => d.count));
  c.clearRect(0, 0, W, H);
  data.forEach((d, k) => {
    c.fillStyle = k === sel ? '#ffffff' : d.count ? '#ff6b4a' : '#3a4048';
    const h = d.count ? ((H - 12) * d.count) / max : 3;
    c.fillRect(k * bw + 1, H - h - 10, bw - 2, h);
  });
  c.fillStyle = '#9aa0a6'; c.font = '10px system-ui';
  c.fillText('night 1', 0, H - 1); c.fillText(`${data.length}`, W - 14, H - 1);
}
