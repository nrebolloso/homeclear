// Doorways in the scene: the measured clear width across each marked opening, and, once a widening fix is applied, the
// scan itself changed to match (Spark SplatEdit on the room splat): the wall strip each jamb moves into is hidden, the
// jamb band is shifted out by half the gain and tinted "designed". No new geometry; nothing is measured from it (the
// floor map gets its own carve, doors.ts). Lines and cards are scene objects, so they show in the headset.
import * as THREE from 'three';
import { SplatEdit, SplatEditSdf, SplatEditSdfType, SplatEditRgbaBlendMode, type SplatMesh } from '@sparkjsdev/spark';
import { doorFrame, doorEditBoxes, openingSpan, type Door, type EditBox, type Grow } from './doors.ts';
import { card } from './reimagine.ts';

const DESIGNED = new THREE.Color(0.78, 1, 0.96);
const cm = (m: number) => `${(m * 100).toFixed(0)} cm`;

function sdfBox(b: EditBox, o: { opacity: number; color: THREE.Color; displace?: [number, number] }) {
  const s = new SplatEditSdf({ type: SplatEditSdfType.BOX, opacity: o.opacity, color: o.color, displace: new THREE.Vector3(o.displace?.[0] ?? 0, o.displace?.[1] ?? 0, 0) });
  s.position.set(...b.center); s.rotation.z = b.yaw; s.scale.set(...b.half);   // a box SDF's scale is its half size
  s.updateMatrixWorld();
  return s;
}
function edit(sdf: SplatEditSdf) {
  const e = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, softEdge: 0.01 });
  e.addSdf(sdf);
  return e;
}

/** `room`: the scan the edits apply to (children of a SplatMesh only edit that mesh). */
export function createDoors3d(scene: THREE.Scene, room: SplatMesh) {
  const marks = new THREE.Group();
  scene.add(marks);
  let edits: SplatEdit[] = [], key = '';

  function clearMarks() {
    for (const c of [...marks.children]) { marks.remove(c); c.traverse(x => { (x as THREE.Mesh).geometry?.dispose(); ((x as THREE.Mesh).material as THREE.Material)?.dispose(); }); }
  }
  /** `change`: how much wider each door is in the layout on screen, and on which side; `ok`: whether its check passes. */
  function build(doors: Door[], change: Record<string, { gain: number; grow: Grow }>, ok: Record<string, boolean>) {
    clearMarks();
    for (const d of doors) {
      const F = doorFrame(d), { gain: g, grow } = change[d.name] ?? { gain: 0, grow: 'both' as Grow }, w = F.width + g, h = F.height;
      const [s0, s1] = openingSpan(F, g, grow);
      const P = (s: number, z: number) => { const [x, y] = F.world(s, 0); return new THREE.Vector3(x, y, z); };
      const col = ok[d.name] ? 0x7dffa8 : 0xff6b6b;
      const span = new THREE.Line(new THREE.BufferGeometry().setFromPoints([P(s0, 0.04), P(s1, 0.04)]),
        new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true }));
      marks.add(span);
      const tag = card([`${d.name}: ${cm(w)} clear`, g ? `designed, not built (was ${cm(F.width)})` : 'between the marked jambs'],
        ok[d.name] ? '#7dffa8' : '#ff9a9a', 'rgba(14,20,28,0.78)', 0.045);
      tag.position.copy(P((s0 + s1) / 2, 1.15));
      marks.add(tag);
      if (g > 0) {   // the new opening's outline, in the designed tint
        const pts = [P(s0, 0), P(s0, h), P(s1, h), P(s1, 0)];
        marks.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x2fd6c8, depthTest: false, transparent: true })));
      }
    }
    marks.traverse(o => { o.renderOrder = 3; });   // after the splats: they don't write depth

    // the scan edits only change when a door or its gain changes (each change regenerates the room splat)
    const k = JSON.stringify(doors.map(d => [d.name, d.a, d.b, change[d.name] ?? null]));
    if (k === key) return;
    key = k;
    for (const e of edits) room.remove(e);
    edits = [];
    const widened = doors.filter(d => (change[d.name]?.gain ?? 0) > 0).map(d => doorEditBoxes(d, change[d.name].gain, change[d.name].grow));
    for (const { hide } of widened) for (const b of hide) edits.push(edit(sdfBox(b, { opacity: 0, color: new THREE.Color(1, 1, 1) })));   // hide first:
    for (const { shift } of widened) for (const b of shift) edits.push(edit(sdfBox(b, { opacity: 1, color: DESIGNED, displace: b.displace })));   // later edits see moved points
    if (edits.length) room.add(...edits);
  }
  return { build, marks, edits: () => edits };
}
