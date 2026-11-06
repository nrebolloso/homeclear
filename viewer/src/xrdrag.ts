// In-headset feedback for editing furniture with the wand (xr.ts): an arrow and a dashed ghost from where a dragged object
// came from, a footprint ring and the verbs under the pointed-at one, and a short arrow + ghost after a reset. All scene
// objects (AGENTS.md: no DOM in the headset). Floor frame: metres, +z up.
import * as THREE from 'three';
import { own } from './lifetime.ts';
import type { Pose } from './grid.ts';

const BLUE = 0x5fd0ff, RED = 0xff3030, GREEN = 0x9be8b0, FLASH_S = 1.2;
type Box = { proxy: THREE.Object3D };
type MakeCard = (lines: string[], color?: string, bg?: string, lineH?: number) => THREE.Sprite;

const onTop = (o: THREE.Object3D, order = 3) => o.traverse(x => { const m = (x as THREE.Mesh).material as THREE.Material | undefined; if (m) { m.depthTest = false; m.transparent = true; } x.renderOrder = order; });

export function dragFeedback(scene: THREE.Scene, items: Box[], makeCard: MakeCard) {
  const root = new THREE.Group(); scene.add(root);
  const loop = (w: number, d: number, color: number, dashed: boolean) => {
    const g = new THREE.BufferGeometry().setFromPoints([[-w, -d], [w, -d], [w, d], [-w, d]].map(([x, y]) => new THREE.Vector3(x / 2, y / 2, 0)));
    const m = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 0.08, gapSize: 0.05, depthTest: false, transparent: true })
      : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
    const l = new THREE.LineLoop(g, m); l.renderOrder = 3; if (dashed) l.computeLineDistances(); return l;
  };
  /** the footprint rectangle of item k when its pivot sits at pose: centre (floor frame) and heading */
  const footprint = (k: number, p: Pose) => {
    const px = items[k].proxy, c = Math.cos(p.yaw), s = Math.sin(p.yaw), ox = px.position.x, oy = px.position.y;
    const g = (px as THREE.Mesh).geometry as THREE.BoxGeometry, par = g.parameters;
    return { x: p.x + c * ox - s * oy, y: p.y + s * ox + c * oy, yaw: p.yaw + px.rotation.z, w: par.width, d: par.depth };
  };
  const rectAt = (k: number, p: Pose, color: number, dashed: boolean) => {
    const f = footprint(k, p), l = loop(f.w, f.d, color, dashed);
    l.position.set(f.x, f.y, 0.03); l.rotation.z = f.yaw; return { l, f };
  };
  const arrow = (from: { x: number; y: number }, to: { x: number; y: number }, color: number) => {
    const dir = new THREE.Vector3(to.x - from.x, to.y - from.y, 0), len = dir.length();
    if (len < 0.05) return null;
    const a = new THREE.ArrowHelper(dir.normalize(), new THREE.Vector3(from.x, from.y, 0.06), len, color, Math.min(0.2, len * 0.5), 0.12);
    onTop(a); return a;
  };
  const kill = (o: THREE.Object3D) => {
    o.removeFromParent();
    o.traverse(x => { if (x instanceof THREE.LineLoop) x.geometry.dispose();   // arrows and sprites share one static geometry
      const m = (x as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined; [m].flat().forEach(y => y?.dispose?.()); });
  };

  // ---- while dragging: the old spot as a dashed ghost, an arrow from it to where the object is now (blue; red = won't fit) ----
  const dragGroup = new THREE.Group(); root.add(dragGroup);
  let dragKey = '';
  const emptyDrag = () => { for (const c of [...dragGroup.children]) kill(c); dragKey = ''; };
  function drag(k: number, from: Pose, to: Pose, ok: boolean) {
    const key = `${k}|${from.x.toFixed(2)},${from.y.toFixed(2)},${from.yaw.toFixed(2)}|${to.x.toFixed(2)},${to.y.toFixed(2)},${to.yaw.toFixed(2)}|${ok}`;
    if (key === dragKey) return;
    emptyDrag(); dragKey = key;
    const color = ok ? BLUE : RED;
    dragGroup.add(rectAt(k, from, BLUE, true).l);
    const a = arrow(footprint(k, from), footprint(k, to), color);
    if (a) dragGroup.add(a);
  }

  // ---- pointed at: a ring under the object and the verbs, low beside its centre (the name pill is main.ts's objLabel, above it) ----
  const hoverGroup = new THREE.Group(); root.add(hoverGroup);
  let hoverKey = '';
  const emptyHover = () => { for (const c of [...hoverGroup.children]) kill(c); hoverKey = ''; };
  function hover(k: number, p: Pose | null, verbs: string[]) {
    const key = p && k >= 0 ? `${k}|${p.x.toFixed(2)},${p.y.toFixed(2)},${p.yaw.toFixed(2)}|${verbs.join('/')}` : '';
    if (key === hoverKey) return;
    emptyHover();
    if (!key) return;
    hoverKey = key;
    const { l, f } = rectAt(k, p!, BLUE, false); hoverGroup.add(l);
    const c = makeCard(verbs, '#7fe7de', 'rgba(14,20,28,0.85)', 0.05); c.position.set(f.x, f.y, 0.12); c.renderOrder = 4; hoverGroup.add(c);
  }

  // ---- after a reset: an arrow back to the original spot and a ghost of it, fading over FLASH_S ----
  type Flash = { g: THREE.Group; age: number };
  const flashes: Flash[] = [];
  function flash(k: number, from: Pose | null, to: Pose) {
    const g = new THREE.Group();
    g.add(rectAt(k, to, GREEN, true).l);
    if (from) { const a = arrow(footprint(k, from), footprint(k, to), GREEN); if (a) g.add(a); }
    root.add(g); flashes.push({ g, age: 0 });
  }
  function update(dt: number) {
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i]; f.age += dt;
      const op = Math.max(0, 1 - f.age / FLASH_S);
      f.g.traverse(x => { const m = (x as THREE.Mesh).material as THREE.Material | undefined; if (m) m.opacity = op; });
      if (f.age >= FLASH_S) { kill(f.g); flashes.splice(i, 1); }
    }
  }
  function clear() { emptyDrag(); emptyHover(); for (const f of flashes) kill(f.g); flashes.length = 0; }
  own(() => { clear(); root.removeFromParent(); });
  return {
    drag, hover, flash, update, clear, clearDrag: emptyDrag,
    state: () => ({ arrow: dragGroup.children.some(c => c instanceof THREE.ArrowHelper), ghost: dragGroup.children.some(c => c instanceof THREE.LineLoop),
      hover: hoverGroup.children.length > 0, flash: flashes.length }),
  };
}
