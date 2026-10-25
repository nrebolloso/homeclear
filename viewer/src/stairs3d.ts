// Stairs in the scene: what was measured (riser faces and tread noses tinted by code, dimension marks, a summary card) and
// the additions once applied (a handrail, motion step lights, a second walker at the top, ...). Scene objects only, so they
// show in the headset. Additions are DESIGNED, not built: teal, labelled, never measured. While a proposal is being previewed
// they are a see-through hologram that builds up the flight as the room morphs (`setT`); once committed they are solid, and
// the rail, brackets, grab bar and edge strips are baked into Gaussians (bake.ts) so they take the room's light.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { stairFrame, pitchAt, parkedPose, grabSide, CODE, STAIRLIFT, type Stair, type Side, type ParkPose } from './stairs.ts';
import { card } from './reimagine.ts';
import { blob } from './ground.ts';
import { sampleShapes, type BakeShape, type RGB } from './bake.ts';
import { railSplats, barSplats, overNosing, NEUTRAL_RAIL, type RailOpts } from './railsplat.ts';
import { DESIGNED, hologram, solid, glow, smooth01, reducedMotion, type Hologram, type Flight } from './designed.ts';

const cm = (m: number) => `${(m * 100).toFixed(0)} cm`;
const cm1 = (m: number) => `${(m * 100).toFixed(1)} cm`;
const rgbOf = (hex: number): RGB => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
// natural finishes once committed (a stairlift is a product, not teal): brushed steel, a dark carriage, a vinyl seat
const STEEL = 0xc4c8cf, CARRIAGE = 0x33363d, VINYL = 0x23252b;
/** a cheap fingerprint of splat records (position, colour...), so a rail that moved or changed colour is baked again */
const checksum = (a: Float32Array) => { let x = 0; for (let i = 0; i < a.length; i++) x += a[i] * ((i % 7) + 1); return +x.toFixed(3); };
const FADE_S = 0.9;   // a proposal solidifies into the scan over this long

export type Phase = 'proposed' | 'committed';
/** the baked fixtures as one splat mesh (main.ts caches it by key); `opacity` fades it with the morph */
export type Baker = (key: string, data: Float32Array) => (THREE.Object3D & { opacity?: number }) | null;

function dispose(grp: THREE.Object3D) {
  for (const c of [...grp.children]) {
    grp.remove(c);
    if (c.userData.shared) continue;   // a copied scan rail or a baked fixture: kept by its owner, re-added on the next build
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
 *  copy: then a drawn tube stands in. The step lights are thin fixtures here; the light itself is the night shader's. `bake`
 *  turns committed fixtures into Gaussians (main.ts); without it they stay solid meshes. `tone(st)` is the colour of the scanned
 *  rail on that stair (neutral metal if none): committed rails, brackets and the grab bar are drawn in it, not in teal. */
export function createStairs3d(scene: THREE.Scene, device: () => THREE.Group, scanRail: (st: Stair, side: Side) => THREE.Object3D | null = () => null,
  chair: () => THREE.Group = device, bake: Baker | null = null, tone: (st: Stair) => RGB = () => NEUTRAL_RAIL) {
  const root = new THREE.Group(), measured = new THREE.Group(), fixes = new THREE.Group(), fading = new THREE.Group();
  root.add(measured, fixes, fading);
  scene.add(root);
  const lights: THREE.Mesh[] = [], pick: THREE.Mesh[] = [], glows: THREE.Sprite[] = [];
  /** stairlift carriages: ride up and down their rail (update) so the lift reads as one */
  const carriages: { grp: THREE.Group; place: (s: number) => void; run: number }[] = [];
  let phase: Phase = 'committed', tNow = 1, clock = 0;
  let holos = new Map<string, Hologram>(), fadeMats: THREE.Material[] = [], baked: (THREE.Object3D & { opacity?: number })[] = [];
  /** the opacity a faded material has when fully shown, if not 1 (a shadow, the walker's path) */
  let fadeBase = new Map<THREE.Material, number>();
  const fadeIn = (m: THREE.Material, base = 1) => { m.transparent = true; fadeMats.push(m); if (base !== 1) fadeBase.set(m, base); };
  let fatMats: LineMaterial[] = [], pulse: { mat: THREE.MeshBasicMaterial; base: number }[] = [];
  let fadingHolos: Hologram[] = [], fadeStart: number | null = null, commitStart: number | null = null;

  /** placed: the parked walker moved by hand, by fix id (layout.placed). `ph`: a proposal being previewed (x-ray) or committed */
  function build(stairs: Stair[], added: string[], placed: Record<string, ParkPose> = {}, ph: Phase = 'committed') {
    if (phase === 'proposed' && ph === 'committed' && fixes.children.length) {   // solidify: the hologram fades out while the baked one fades in
      for (const c of [...fixes.children]) if (!c.userData.shared) fading.add(c);
      fadingHolos = [...holos.values()]; fadeStart = commitStart = clock;
    }
    phase = ph;
    dispose(measured); dispose(fixes); lights.length = 0; pick.length = 0; carriages.length = 0; glows.length = 0;
    holos = new Map(); fadeMats = []; fadeBase = new Map(); baked = []; fatMats = []; pulse = [];
    const shapes: BakeShape[] = [], extra: { id: string; recs: Float32Array }[] = [];
    const tag = phase === 'proposed' ? 'proposed, not built' : 'designed, not built';

    /** a fat line (world-unit width, so a headset and a monitor see the same); thin dark halo beneath keeps it readable on any floor */
    const fat = (pts: THREE.Vector3[], color: number, width: number, opacity = 1, halo = true) => {
      const mk = (c: number, w: number, o: number) => {
        const g = new LineGeometry(); g.setPositions(pts.flatMap(p => [p.x, p.y, p.z]));
        const m = new LineMaterial({ color: c, linewidth: w, worldUnits: true, transparent: true, opacity: o, depthTest: false });
        fatMats.push(m);
        const l = new Line2(g, m); l.computeLineDistances(); return l;
      };
      const grp = new THREE.Group();
      if (halo) grp.add(mk(0x0b1016, width * 2.1, opacity * 0.55));
      grp.add(mk(color, width, opacity));
      return grp;
    };

    for (const st of stairs) {
      const F = stairFrame(st), pitch = pitchAt(st), half = F.width / 2, z = st.treads_z ?? [];
      const P = (s: number, t: number, h: number) => { const [x, y] = F.world(s, t); return new THREE.Vector3(x, y, h); };
      const fronts = st.tread_fronts_m?.length === z.length ? st.tread_fronts_m : z.map((_, k) => k * (st.tread_depth_m ?? 0.27));
      const flight: Flight = { origin: F.world(0, 0) as [number, number], dir: [F.u[0], F.u[1]], run: F.run + 1.5 };   // + the landing, where the walker waits
      const holoFor = (color: number) => { const key = `${st.name}:${color}`; let h = holos.get(key); if (!h) { h = hologram(flight, color); holos.set(key, h); } return h; };
      /** the material a fixture is drawn in now: hologram while proposed, shaded solid once committed */
      const look = (color = DESIGNED, rough = 0.5): THREE.Material => {
        if (phase === 'proposed') return holoFor(color);
        const m = solid(color, rough); fadeIn(m); return m;
      };
      /** a finish for a committed fixture in its natural colour; while proposed it is the teal hologram like everything else */
      const fin = (color: number, rough = 0.5, metal = 0.15): THREE.Material => {
        if (phase === 'proposed') return holoFor(DESIGNED);
        const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, transparent: true }); fadeIn(m); return m;
      };
      /** a committed rail, baked as dense splats in the scanned rail's colour (railsplat.ts); false while proposed (the hologram tube draws it) */
      const committedRail = (id: string, o: Omit<RailOpts, 'tone'>) => {
        if (phase !== 'committed' || !bake) return false;
        extra.push({ id: `${id}:${st.name}`, recs: railSplats(st, { ...o, tone: tone(st) }) });
        return true;
      };
      /** a tube along a polyline: baked into the scan once committed, else a mesh */
      const tube = (pts: THREE.Vector3[], r: number, color = DESIGNED) => {
        if (phase === 'committed' && bake) { for (let i = 1; i < pts.length; i++) shapes.push({ kind: 'tube', a: pts[i - 1].toArray() as [number, number, number], b: pts[i].toArray() as [number, number, number], r, color: rgbOf(color) }); return; }
        const path = new THREE.CurvePath<THREE.Vector3>();
        for (let i = 1; i < pts.length; i++) path.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
        fixes.add(new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(4, pts.length * 12), r, 10, false), look(color)));
      };
      /** a tinted card: leaves a leader line to `at` when asked */
      const mark = (lines: string[], color: string, pos: THREE.Vector3, size: number, group: THREE.Group, leaderTo?: THREE.Vector3) => {
        const c = card(lines, color, 'rgba(14,20,28,0.9)', size);
        c.position.copy(pos); group.add(c);
        if (group === fixes) fadeIn(c.material);   // an addition's label arrives with the addition
        if (leaderTo) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([pos, leaderTo]), lineMat(0xffffff, 0.35)); group.add(l); }
      };

      // ---- measured: the flight's two edges, each riser as a tinted face, each tread nose as a line, a dimension mark per riser
      const risers = z.map((v, k) => v - (k ? z[k - 1] : 0));
      for (const t of [half, -half]) {
        const prof = z.length ? z.flatMap((h, k) => [P(fronts[k], t, h - risers[k] + 0.005), P(fronts[k], t, h + 0.005)]) : [P(0, t, 0.02), P(F.run, t, pitch(F.run))];
        measured.add(fat(prof, 0x8fe3ff, 0.007, 0.8));
      }
      z.forEach((h, k) => {
        const over = risers[k] - CODE.riser_max_m, bad = over > 0, col = bad ? 0xff5050 : 0x8fe3ff, lo = h - risers[k];
        // the riser's face, in the code's colour: red out of code, a faint wash otherwise
        const q = [P(fronts[k], half, lo), P(fronts[k], -half, lo), P(fronts[k], -half, h), P(fronts[k], half, h)];
        const face = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([q[0], q[1], q[2], q[0], q[2], q[3]]),
          new THREE.MeshBasicMaterial({ color: bad ? 0xff3b3b : 0x59d8ff, transparent: true, opacity: bad ? 0.32 : 0.1, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
        if (bad) pulse.push({ mat: face.material as THREE.MeshBasicMaterial, base: 0.32 });
        measured.add(face);
        measured.add(fat([P(fronts[k], half, h + 0.005), P(fronts[k], -half, h + 0.005)], col, bad ? 0.013 : 0.008, 0.95));
        // a dimension mark beside the riser: vertical, with ticks, and for a bad one a notch where the limit would have been
        const d = half + 0.07, tick = (hh: number, c: number) => fat([P(fronts[k], d - 0.035, hh), P(fronts[k], d + 0.035, hh)], c, 0.004, 0.9, false);
        measured.add(fat([P(fronts[k], d, lo), P(fronts[k], d, h)], bad ? 0xff9a9a : 0xc9f0ff, 0.004, 0.9, false), tick(lo, 0xc9f0ff), tick(h, 0xc9f0ff));
        if (bad) measured.add(tick(lo + CODE.riser_max_m, 0xffc83d));
        const anchor = P(fronts[k], half + 0.12, h + 0.06);
        mark(bad ? [`${cm(risers[k])} riser`, `+${cm1(over)} over the ${cm1(CODE.riser_max_m)} limit`] : [`${cm(risers[k])} riser`], bad ? '#ff9a9a' : '#c9f0ff', anchor, bad ? 0.04 : 0.035, measured, P(fronts[k], half, lo + risers[k] / 2));
      });
      const lo = risers.length ? Math.min(...risers) : 0, hi = risers.length ? Math.max(...risers) : 0;
      const railTxt = (s: Side) => (st.rails ? st.rails[s] : '?');
      const summary = card([`${st.name}: ${z.length} tread${z.length === 1 ? '' : 's'} ${st.measured === 'tape' ? 'tape-measured' : 'seen'}`,
        z.length ? `risers ${cm(lo)}–${cm(hi)} · treads ${st.tread_depth_m ? cm(st.tread_depth_m) : '?'} deep` : 'steps not captured',
        `${cm(st.width_m ?? F.width)} wide · rails: left ${railTxt('left')}, right ${railTxt('right')}`], '#8fe3ff', 'rgba(14,20,28,0.9)', 0.05);
      summary.position.copy(P(F.run / 2, 0, pitch(F.run / 2) + 1.5));
      measured.add(summary);

      // ---- additions, once applied (proposed: hologram; committed: solid or baked)
      const top = st.top_z ?? pitch(F.run);
      for (const side of ['left', 'right'] as Side[]) {
        if (!added.includes(`stair_rail:${st.name}:${side}`)) continue;
        const t = (side === 'left' ? 1 : -1) * (half - 0.06), y0 = pitch(0) + 0.9, y1 = pitch(F.run) + 0.9;
        const copy = phase === 'committed' ? scanRail(st, side) : null;   // a proposal shows the drawn rail: the copy is a scan splat
        if (copy) {   // the scanned rail, mirrored: real material in the room's own light
          copy.userData.shared = true;
          fixes.add(copy); baked.push(copy);   // a splat: it fades in with the morph like the baked fixtures
          mark([tag, `handrail (${side}), copied from the scanned one`], '#7ff5e8', P(F.run * 0.3, t, pitch(F.run * 0.3) + 1.1), 0.04, fixes);
          continue;
        }
        if (!committedRail(`rail:${side}`, { t: (side === 'left' ? 1 : -1) * (half - 0.09), z: overNosing(st, 0.9) })) {   // committed: splats with returns and wall brackets
          tube([P(-0.3, t, y0), P(0, t, y0), P(F.run, t, y1), P(F.run + 0.3, t, y1)], 0.022);   // returns 30 cm past each end, level
          for (let s = 0.2; s < F.run; s += 0.9) {   // brackets, under the rail
            const at = P(s, t + (side === 'left' ? 0.04 : -0.04), pitch(s) + 0.9 - 0.02);
            tube([at.clone().setZ(at.z - 0.04), at.clone().setZ(at.z + 0.04)], 0.008);
          }
        }
        mark([tag, `handrail (${side})`], '#7ff5e8', P(F.run * 0.3, t, pitch(F.run * 0.3) + 1.1), 0.04, fixes);
      }
      if (added.includes(`stair_lights:${st.name}`)) z.forEach((h, k) => {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.03, F.width - 0.12, 0.012), new THREE.MeshBasicMaterial({ color: 0xfff4d6, transparent: true }));
        fadeIn(strip.material as THREE.Material);
        strip.position.copy(P(fronts[k] + 0.02, 0, h + 0.008));
        strip.rotation.z = Math.atan2(F.u[1], F.u[0]);
        fixes.add(strip);
        lights.push(strip);
        const g = glow(0.55); g.position.copy(P(fronts[k] + 0.02, 0, h + 0.06)); fixes.add(g); glows.push(g);   // lit at night (update)
      });
      const gs = grabSide(st), tg = (gs === 'left' ? 1 : -1) * half;
      for (const side of ['left', 'right'] as Side[]) {   // a scanned rail at the wrong height, refitted at 90 cm
        if (!added.includes(`stair_rail_up:${st.name}:${side}`)) continue;
        const t = (side === 'left' ? 1 : -1) * (half - 0.06);
        if (!committedRail(`rail_up:${side}`, { t: (side === 'left' ? 1 : -1) * (half - 0.09), z: overNosing(st, 0.9), returns: false })) tube([P(0, t, pitch(0) + 0.9), P(F.run, t, pitch(F.run) + 0.9)], 0.02);
        mark([tag, `${side} rail refitted at 90 cm`], '#7ff5e8', P(F.run * 0.5, t, pitch(F.run * 0.5) + 1.15), 0.04, fixes);
      }
      if (added.includes(`stair_rail_ext:${st.name}`)) {   // level returns past the bottom and the top step
        const t = tg - Math.sign(tg) * 0.06, hb = pitch(0) + 0.9, ht = pitch(F.run) + 0.9;
        if (!committedRail('rail_ext', { t: Math.sign(tg) * (half - 0.09), z: overNosing(st, 0.9), flight: false }))
          for (const [s0, s1, h] of [[-0.3, 0, hb], [F.run, F.run + 0.3, ht]] as const) tube([P(s0, t, h), P(s1, t, h)], 0.022);
        mark([tag, 'rail runs on 30 cm'], '#7ff5e8', P(F.run + 0.15, t, ht + 0.25), 0.04, fixes);
      }
      if (added.includes(`stair_grab:${st.name}`)) {   // a vertical bar on the landing wall, where the rail ends
        const at = P(F.run + 0.2, tg + Math.sign(tg) * 0.03, top + 0.95);
        if (phase === 'committed' && bake) extra.push({ id: `grab:${st.name}`, recs: barSplats([[at.x, at.y, at.z - 0.225], [at.x, at.y, at.z + 0.225]], 0.018, tone(st)) });
        else tube([at.clone().setZ(at.z - 0.225), at.clone().setZ(at.z + 0.225)], 0.018);
        mark([tag, 'grab bar at the top'], '#7ff5e8', P(F.run + 0.2, tg, top + 1.35), 0.04, fixes);
      }
      if (added.includes(`stair_nosing:${st.name}`)) z.forEach((h, k) => {   // contrasting strip right on each nose
        const at = P(fronts[k] + 0.02, 0, h + 0.004), yaw = Math.atan2(F.u[1], F.u[0]);
        if (phase === 'committed' && bake) { shapes.push({ kind: 'box', c: at.toArray() as [number, number, number], half: [0.02, (F.width - 0.04) / 2, 0.003], yaw, color: rgbOf(0xffc83d) }); return; }
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.04, F.width - 0.04, 0.006), look(0xffc83d, 0.7));
        strip.position.copy(at); strip.rotation.z = yaw;
        fixes.add(strip);
      });
      /** recolour a parked walker or chair: a hologram while proposed, else its own shaded materials (cloned, to fade in) */
      const designed = (obj: THREE.Object3D) => obj.traverse(m => {
        const mesh = m as THREE.Mesh, mat = mesh.material as THREE.MeshStandardMaterial | undefined;
        if (m.userData.shadow) { if (mat) fadeIn(mat, m.userData.strength ?? 0.5); return; }   // its contact shadow goes with it
        if (!mat?.color) return;
        if (phase === 'proposed') { mesh.material = holoFor(DESIGNED); return; }
        m.userData.mat = mat.clone(); mesh.material = m.userData.mat;   // committed: the aid keeps its own colours; the card says "designed, not built"
        fadeIn(m.userData.mat);
      });
      if (added.includes(`stair_lift:${st.name}`)) {   // rail on the treads by the wall, a seat that rides it, a chair waiting upstairs
        const side: Side = st.rails?.left === 'seen' && st.rails?.right !== 'seen' ? 'right' : 'left', sg = side === 'left' ? 1 : -1, tw = sg * (half - 0.06);
        const mat = fin(CARRIAGE, 0.45, 0.3), seatMat = fin(VINYL, 0.85, 0.05), steel = fin(STEEL, 0.3, 0.8);
        const path = new THREE.LineCurve3(P(-0.25, tw, pitch(0) + 0.12), P(F.run + 0.15, tw, top + 0.12));
        fixes.add(new THREE.Mesh(new THREE.TubeGeometry(path, 8, 0.035, 12, false), steel));
        for (let ps = 0.1; ps < F.run + 0.1; ps += 0.7) {   // posts holding the track off the treads
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.12, 8), steel);
          post.position.copy(P(ps, tw, pitch(ps) + 0.06)); post.rotation.x = Math.PI / 2;
          fixes.add(post);
        }
        const grp = new THREE.Group(), box = (w: number, d: number, h: number, x: number, y: number, zz: number, m = mat) => {
          const b = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), m); b.position.set(x, y, zz); grp.add(b); return b;
        };
        // carriage frame: x along the flight, y toward the middle of the stair, z up; the seat faces across the flight
        const depth = STAIRLIFT.folded_m;
        box(0.3, 0.12, 0.5, 0, 0.06, 0.4);                  // carriage on the rail
        box(0.42, 0.42, 0.07, 0, depth, 0.52, seatMat);     // seat (unfolded)
        box(0.42, 0.06, 0.45, 0, 0.1, 0.8, seatMat);        // back, against the wall side
        box(0.06, 0.3, 0.05, 0.2, depth, 0.68); box(0.06, 0.3, 0.05, -0.2, depth, 0.68);   // armrests
        box(0.3, 0.22, 0.03, 0, depth + 0.22, 0.12);        // footplate
        const shadow = blob(0.2, 0.16, 0.45); shadow.position.set(0, depth + 0.1, 0.002); grp.add(shadow);   // rides with it, on the tread under the footplate
        fadeIn(shadow.material as THREE.Material, 0.45);
        grp.rotation.z = Math.atan2(F.u[1], F.u[0]);
        grp.scale.set(1, -sg, 1);   // local y runs from the wall side into the stair (three flips the faces for the mirror)
        const place = (sc: number) => grp.position.copy(P(sc, tw, pitch(sc)));   // the seat stays level as it rides
        place(0);
        fixes.add(grp);
        carriages.push({ grp, place, run: F.run });
        const up = chair(), cp = F.world(F.run + 0.55, tw - sg * 0.35);
        up.position.set(cp[0], cp[1], top);
        up.rotation.z = Math.atan2(-F.u[1], -F.u[0]);   // facing back toward the lift, to roll up to its seat
        designed(up);
        fixes.add(up);
        mark([tag, `stairlift (typical size, folds to ${cm(depth)})`, 'second wheelchair waits upstairs'], '#7ff5e8', P(F.run * 0.5, tw - sg * 0.3, pitch(F.run * 0.5) + 1.3), 0.04, fixes);
      }
      const wid = `stair_walker:${st.name}`;
      if (added.includes(wid)) {
        const w = device(), p = placed[wid] ?? parkedPose(st);   // the device's origin is the user's body: frame ahead, on the landing
        w.position.set(p.x, p.y, top);
        w.rotation.z = p.yaw;   // facing on, where the patient steps into it off the last step
        designed(w);
        if (st.top_device === 'rollator') {   // a seat between the side rails (and the wheels are implied: same frame)
          const seat = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.4, 0.03), fin(VINYL, 0.85, 0.05));
          seat.position.set(0.42, 0, 0.55);
          w.add(seat);
        }
        // the patient's way in: a faint dashed arc from the last tread onto the landing and into the frame
        const arcA = P(F.run - 0.25, 0, top + 0.02), arcB = new THREE.Vector3(p.x, p.y, top + 0.02), mid = arcA.clone().lerp(arcB, 0.5).add(new THREE.Vector3(-F.u[1], F.u[0], 0).multiplyScalar(0.12));
        const arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(new THREE.QuadraticBezierCurve3(arcA, mid, arcB).getPoints(18)), new THREE.LineDashedMaterial({ color: DESIGNED, dashSize: 0.05, gapSize: 0.04, transparent: true, opacity: 0.7, depthTest: false }));
        arc.computeLineDistances();
        fixes.add(arc); fadeIn(arc.material as THREE.Material, 0.7);
        // a box around the frame to pick it with the mouse or the VR pointer (main.ts drags it on the landing)
        const proxy = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 1.0), new THREE.MeshBasicMaterial({ visible: false }));
        proxy.position.set(0.4, 0, 0.5);
        proxy.userData.parked = wid;
        w.add(proxy);
        pick.push(proxy);
        fixes.add(w);
        mark([tag, `${st.top_device === 'rollator' ? 'rollator' : 'second walker'} waits here · drag to move`], '#7ff5e8', new THREE.Vector3(p.x, p.y, top + 1.2), 0.04, fixes);
      }
    }
    // the rail, brackets, grab bar and edge strips, baked into the scan: one splat mesh for all of them (cached by main.ts)
    if (phase === 'committed' && bake && (shapes.length || extra.length)) {
      const sh = sampleShapes(shapes), data = new Float32Array(sh.length + extra.reduce((a, e) => a + e.recs.length, 0));
      data.set(sh); let at = sh.length;
      for (const e of extra) { data.set(e.recs, at); at += e.recs.length; }
      const m = bake(JSON.stringify([shapes, extra.map(e => [e.id, e.recs.length, checksum(e.recs)])], (_, v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v)), data);
      if (m) { m.userData.shared = true; fixes.add(m); baked.push(m); }
    }
    // after the splats (they don't write depth: drawn first, the dimmed splat would paint over the rail and the lights)
    for (const grp of [measured, fixes]) grp.traverse(o => { o.renderOrder = Math.max(o.renderOrder, 3); });
  }

  return {
    root, build,
    /** the parked walkers' pick boxes (userData.parked = the fix id) */
    walkers: () => pick,
    /** the morph's progress (reimagine.ts onT): 0 = the room as filmed, no additions; 1 = all of them. Proposed ones build up the flight. */
    setT(t: number) { tNow = t; },
    /** the additions are drawn as a proposal (hologram) or committed (solid, baked) */
    phase: () => phase,
    /** per frame: the strips themselves are lit at night, dim by day (the light on the steps is the night shader's,
     *  steady: changing it would regenerate every splat) */
    update(_t: number, night: boolean) {
      clock = _t;
      const calm = reducedMotion(), rev = smooth01(tNow), w = innerWidth, h = innerHeight;
      for (const m of fatMats) m.resolution.set(w, h);
      for (const hm of holos.values()) { hm.uniforms.uTime.value = calm ? 0 : _t; hm.uniforms.uReveal.value = rev; hm.uniforms.uAlpha.value = 1; }
      for (const m of fadeMats) m.opacity = rev * (fadeBase.get(m) ?? 1);
      const k = fadeStart === null ? 1 : Math.min(1, (_t - fadeStart) / (calm ? 0.01 : FADE_S));
      for (const hm of fadingHolos) { hm.uniforms.uTime.value = calm ? 0 : _t; hm.uniforms.uReveal.value = 1; hm.uniforms.uAlpha.value = 1 - smooth01(k); }
      if (fadeStart !== null && k >= 1) { dispose(fading); fadingHolos = []; fadeStart = commitStart = null; }
      for (const b of baked) b.opacity = Math.min(rev, commitStart === null ? 1 : smooth01(k));
      for (const p of pulse) p.mat.opacity = calm ? p.base : p.base * (0.72 + 0.4 * (0.5 + 0.5 * Math.sin(_t * 3)));
      for (const c of carriages) c.place(c.run * (0.5 - 0.5 * Math.cos((2 * Math.PI * _t) / 16)));   // up and back down every 16 s
      for (const s of lights) ((s.material) as THREE.MeshBasicMaterial).color.setHex(night ? 0xfff4d6 : 0xd8d2c4);
      for (const g of glows) (g.material as THREE.SpriteMaterial).opacity = night ? 0.7 * rev : 0;
    },
    setVisible(on: boolean) { root.visible = on; },
  };
}
