// Stairs in the scene: what was measured (tread noses, out-of-code risers in red, a summary card) and the three
// additions once applied (a handrail, motion step lights, a second walker at the top). Scene objects only, so they show
// in the headset. Additions are DESIGNED, not built: teal, labelled, never measured.
import * as THREE from 'three';
import { stairFrame, pitchAt, parkedPose, grabSide, CODE, type Stair, type Side, type ParkPose } from './stairs.ts';
import { card } from './reimagine.ts';

const DESIGNED = 0x2fd6c8;
const cm = (m: number) => `${(m * 100).toFixed(0)} cm`;

function dispose(grp: THREE.Object3D) {
  for (const c of [...grp.children]) {
    grp.remove(c);
    if (c.userData.shared) continue;   // a copied scan rail: kept by its owner, re-added on the next build
    c.traverse(x => {
      const m = x as THREE.Mesh;
      m.geometry?.dispose();
      for (const mat of [m.material].flat() as THREE.Material[]) mat?.dispose();   // card textures are cached by reimagine.ts, not owned
    });
  }
}
const lineMat = (color: number, opacity = 0.9) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });

/** `device()` builds the patient's walking aid (walker.ts buildDevice) for the one parked at the top. `scanRail(st, side)`
 *  gives the rail for that side copied from the scanned one (stairs.ts mirrorRail), or null where nothing was scanned to
 *  copy: then a drawn tube stands in. The step lights are thin fixtures here; the light itself is the night shader's. */
export function createStairs3d(scene: THREE.Scene, device: () => THREE.Group, scanRail: (st: Stair, side: Side) => THREE.Object3D | null = () => null) {
  const root = new THREE.Group(), measured = new THREE.Group(), fixes = new THREE.Group();
  root.add(measured, fixes);
  scene.add(root);
  const lights: THREE.Mesh[] = [], pick: THREE.Mesh[] = [];

  /** placed: the parked walker moved by hand, by fix id (layout.placed) */
  function build(stairs: Stair[], added: string[], placed: Record<string, ParkPose> = {}) {
    dispose(measured); dispose(fixes); lights.length = 0; pick.length = 0;
    for (const st of stairs) {
      const F = stairFrame(st), pitch = pitchAt(st), half = F.width / 2, z = st.treads_z ?? [];
      const P = (s: number, t: number, h: number) => { const [x, y] = F.world(s, t); return new THREE.Vector3(x, y, h); };
      const fronts = st.tread_fronts_m?.length === z.length ? st.tread_fronts_m : z.map((_, k) => k * (st.tread_depth_m ?? 0.27));
      // the flight's two edges along the tread noses (nothing on the floor under the steps), and a line on each nose
      const risers = z.map((v, k) => v - (k ? z[k - 1] : 0));
      for (const t of [half, -half]) {
        const prof = z.length ? z.flatMap((h, k) => [P(fronts[k], t, h - risers[k] + 0.005), P(fronts[k], t, h + 0.005)]) : [P(0, t, 0.02), P(F.run, t, pitch(F.run))];
        const edge = new THREE.Line(new THREE.BufferGeometry().setFromPoints(prof), lineMat(0x8fe3ff, 0.45));
        measured.add(edge);
      }
      z.forEach((h, k) => {
        const bad = risers[k] > CODE.riser_max_m;
        const nose = new THREE.Line(new THREE.BufferGeometry().setFromPoints([P(fronts[k], half, h + 0.005), P(fronts[k], -half, h + 0.005)]), lineMat(bad ? 0xff5050 : 0x8fe3ff));
        nose.renderOrder = 3;
        measured.add(nose);
        const tag = card([`${cm(risers[k])} riser`], bad ? '#ff9a9a' : '#c9f0ff', 'rgba(14,20,28,0.7)', 0.035);
        tag.position.copy(P(fronts[k], half + 0.12, h + 0.06));
        measured.add(tag);
      });
      const lo = risers.length ? Math.min(...risers) : 0, hi = risers.length ? Math.max(...risers) : 0;
      const railTxt = (s: Side) => (st.rails ? st.rails[s] : '?');
      const summary = card([`${st.name}: ${z.length} tread${z.length === 1 ? '' : 's'} ${st.measured === 'tape' ? 'tape-measured' : 'seen'}`,
        z.length ? `risers ${cm(lo)}–${cm(hi)} · treads ${st.tread_depth_m ? cm(st.tread_depth_m) : '?'} deep` : 'steps not captured',
        `${cm(st.width_m ?? F.width)} wide · rails: left ${railTxt('left')}, right ${railTxt('right')}`], '#8fe3ff', undefined, 0.05);
      summary.position.copy(P(F.run / 2, 0, pitch(F.run / 2) + 1.5));
      measured.add(summary);

      // additions, once applied
      const top = st.top_z ?? pitch(F.run);
      for (const side of ['left', 'right'] as Side[]) {
        if (!added.includes(`stair_rail:${st.name}:${side}`)) continue;
        const t = (side === 'left' ? 1 : -1) * (half - 0.06), y0 = pitch(0) + 0.9, y1 = pitch(F.run) + 0.9;
        const copy = scanRail(st, side);
        if (copy) {   // the scanned rail, mirrored: real material in the room's own light
          copy.userData.shared = true;
          fixes.add(copy);
          const from: Side = side === 'left' ? 'right' : 'left', h = st.rails?.height_m?.[from] ?? st.rails?.peak_m?.[from] ?? 0.9;
          const thin = (copy.userData.count ?? 0) / Math.max(0.3, F.run) < 300;   // a sparse scan copies a dotted rail
          if (thin) {   // so it still reads: a slim outline on the copy's own line and height
            const tc = (side === 'left' ? 1 : -1) * (half - 0.09), line = new THREE.CurvePath<THREE.Vector3>();
            line.add(new THREE.LineCurve3(P(0, tc, pitch(0) + h), P(F.run, tc, pitch(F.run) + h)));
            fixes.add(new THREE.Mesh(new THREE.TubeGeometry(line, 24, 0.012, 8, false), new THREE.MeshBasicMaterial({ color: DESIGNED, transparent: true, opacity: 0.7 })));
          }
          const tag = card(['designed, not built', `handrail (${side}), copied from the scanned one${thin ? ', outlined' : ''}`], '#7ff5e8', 'rgba(14,20,28,0.75)', 0.04);
          tag.position.copy(P(F.run * 0.3, t, pitch(F.run * 0.3) + 1.1));
          fixes.add(tag);
          // The copied scan only covers the flight; the designed addition also promises level returns at both ends.
          for (const [s0, s1, h0] of [[-0.3, 0, pitch(0) + h], [F.run, F.run + 0.3, pitch(F.run) + h]]) {
            const path = new THREE.LineCurve3(P(s0, t, h0), P(s1, t, h0));
            fixes.add(new THREE.Mesh(new THREE.TubeGeometry(path, 4, 0.018, 8, false), new THREE.MeshBasicMaterial({ color: DESIGNED })));
          }
          continue;
        }
        const path = new THREE.CurvePath<THREE.Vector3>();
        path.add(new THREE.LineCurve3(P(-0.3, t, y0), P(0, t, y0)));   // returns 30 cm past each end, level
        path.add(new THREE.LineCurve3(P(0, t, y0), P(F.run, t, y1)));
        path.add(new THREE.LineCurve3(P(F.run, t, y1), P(F.run + 0.3, t, y1)));
        const rail = new THREE.Mesh(new THREE.TubeGeometry(path, 48, 0.022, 10, false), new THREE.MeshBasicMaterial({ color: DESIGNED }));
        fixes.add(rail);
        for (let s = 0.2; s < F.run; s += 0.9) {   // brackets
          const b = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.08, 6), new THREE.MeshBasicMaterial({ color: DESIGNED }));
          b.position.copy(P(s, t + (side === 'left' ? 0.04 : -0.04), pitch(s) + 0.9 - 0.02));
          b.rotation.x = Math.PI / 2;
          fixes.add(b);
        }
        const tag = card(['designed, not built', `handrail (${side})`], '#7ff5e8', 'rgba(14,20,28,0.75)', 0.04);
        tag.position.copy(P(F.run * 0.3, t, pitch(F.run * 0.3) + 1.1));
        fixes.add(tag);
      }
      if (added.includes(`stair_lights:${st.name}`)) z.forEach((h, k) => {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.03, F.width - 0.12, 0.012), new THREE.MeshBasicMaterial({ color: 0xfff4d6 }));
        strip.position.copy(P(fronts[k] + 0.02, 0, h + 0.008));
        strip.rotation.z = Math.atan2(F.u[1], F.u[0]);
        fixes.add(strip);
        lights.push(strip);
      });
      const gs = grabSide(st), tg = (gs === 'left' ? 1 : -1) * half;
      for (const side of ['left', 'right'] as Side[]) {   // a scanned rail at the wrong height, refitted at 90 cm
        if (!added.includes(`stair_rail_up:${st.name}:${side}`)) continue;
        const t = (side === 'left' ? 1 : -1) * (half - 0.06), path = new THREE.LineCurve3(P(0, t, pitch(0) + 0.9), P(F.run, t, pitch(F.run) + 0.9));
        fixes.add(new THREE.Mesh(new THREE.TubeGeometry(path, 24, 0.02, 10, false), new THREE.MeshBasicMaterial({ color: DESIGNED })));
        const tag = card(['designed, not built', `${side} rail refitted at 90 cm`], '#7ff5e8', 'rgba(14,20,28,0.75)', 0.04);
        tag.position.copy(P(F.run * 0.5, t, pitch(F.run * 0.5) + 1.15));
        fixes.add(tag);
      }
      if (added.includes(`stair_rail_ext:${st.name}`)) {   // level returns past the bottom and the top step
        const t = tg - Math.sign(tg) * 0.06, hb = pitch(0) + 0.9, ht = pitch(F.run) + 0.9;
        for (const [s0, s1, h] of [[-0.3, 0, hb], [F.run, F.run + 0.3, ht]] as const) {
          const p = new THREE.CurvePath<THREE.Vector3>();
          p.add(new THREE.LineCurve3(P(s0, t, h), P(s1, t, h)));
          fixes.add(new THREE.Mesh(new THREE.TubeGeometry(p, 6, 0.022, 10, false), new THREE.MeshBasicMaterial({ color: DESIGNED })));
        }
        const tag = card(['designed, not built', 'rail runs on 30 cm'], '#7ff5e8', 'rgba(14,20,28,0.75)', 0.04);
        tag.position.copy(P(F.run + 0.15, t, ht + 0.25));
        fixes.add(tag);
      }
      if (added.includes(`stair_grab:${st.name}`)) {   // a vertical bar on the landing wall, where the rail ends
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.45, 10), new THREE.MeshBasicMaterial({ color: DESIGNED }));
        bar.position.copy(P(F.run + 0.2, tg + Math.sign(tg) * 0.03, top + 0.95));
        bar.rotation.x = Math.PI / 2;   // the cylinder's axis (y) to up (z)
        fixes.add(bar);
        const tag = card(['designed, not built', 'grab bar at the top'], '#7ff5e8', 'rgba(14,20,28,0.75)', 0.04);
        tag.position.copy(P(F.run + 0.2, tg, top + 1.35));
        fixes.add(tag);
      }
      if (added.includes(`stair_nosing:${st.name}`)) z.forEach((h, k) => {   // contrasting strip right on each nose
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.04, F.width - 0.04, 0.006), new THREE.MeshBasicMaterial({ color: 0xffc83d }));
        strip.position.copy(P(fronts[k] + 0.02, 0, h + 0.004));
        strip.rotation.z = Math.atan2(F.u[1], F.u[0]);
        fixes.add(strip);
      });
      const wid = `stair_walker:${st.name}`;
      if (added.includes(wid)) {
        const w = device(), p = placed[wid] ?? parkedPose(st);   // the device's origin is the user's body: frame ahead, on the landing
        w.position.set(p.x, p.y, top);
        w.rotation.z = p.yaw;   // facing on, where the patient steps into it off the last step
        w.traverse(m => { const mat = (m as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (mat?.color) { m.userData.mat = mat.clone(); (m as THREE.Mesh).material = m.userData.mat; m.userData.mat.color.setHex(DESIGNED); } });
        if (st.top_device === 'rollator') {   // a seat between the side rails (and the wheels are implied: same frame)
          const seat = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.4, 0.03), new THREE.MeshBasicMaterial({ color: 0x1d6b66 }));
          seat.position.set(0.42, 0, 0.55);
          w.add(seat);
        }
        // a box around the frame to pick it with the mouse or the VR pointer (main.ts drags it on the landing)
        const proxy = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 1.0), new THREE.MeshBasicMaterial({ visible: false }));
        proxy.position.set(0.4, 0, 0.5);
        proxy.userData.parked = wid;
        w.add(proxy);
        pick.push(proxy);
        fixes.add(w);
        const tag = card(['designed, not built', `${st.top_device === 'rollator' ? 'rollator' : 'second walker'} waits here · drag to move`], '#7ff5e8', 'rgba(14,20,28,0.75)', 0.04);
        tag.position.set(p.x, p.y, top + 1.2);
        fixes.add(tag);
      }
    }
    // after the splats (they don't write depth: drawn first, the dimmed splat would paint over the rail and the lights)
    for (const grp of [measured, fixes]) grp.traverse(o => { o.renderOrder = Math.max(o.renderOrder, 3); });
  }

  return {
    root, build,
    /** the parked walkers' pick boxes (userData.parked = the fix id) */
    walkers: () => pick,
    /** per frame: the strips themselves are lit at night, dim by day (the light on the steps is the night shader's,
     *  steady: changing it would regenerate every splat) */
    update(_t: number, night: boolean) {
      for (const s of lights) ((s.material) as THREE.MeshBasicMaterial).color.setHex(night ? 0xfff4d6 : 0xd8d2c4);
    },
    setVisible(on: boolean) { root.visible = on; },
  };
}
