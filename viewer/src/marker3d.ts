// The marking tool in the scene (marker.ts): the pointer riding the splat, the points placed, the previews, the handles
// on measured stairs and doorways, and the rail toggles. Scene objects only, so the same tool works in the headset.
import * as THREE from 'three';
import { card } from './reimagine.ts';
import type { P3, Preview, Handle, Tone } from './marker.ts';
import { reducedMotion } from './designed.ts';

const TONE: Record<Tone, number> = { info: 0x8fe3ff, ok: 0x7dff9a, bad: 0xff6b6b, side: 0xffd84d };
const TEXT: Record<Tone, string> = { info: '#c9f0ff', ok: '#b6ffc6', bad: '#ffb0b0', side: '#ffe27a' };
const basic = (color: number, opacity = 0.95) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
const v3 = (p: P3) => new THREE.Vector3(p[0], p[1], p[2]);

function empty(grp: THREE.Object3D) {
  for (const c of [...grp.children]) {
    grp.remove(c);
    c.traverse(x => { const m = x as THREE.Mesh; m.geometry?.dispose(); for (const mat of [m.material].flat() as THREE.Material[]) mat?.dispose(); });   // card textures are cached by reimagine.ts
  }
}
function line(a: THREE.Vector3, b: THREE.Vector3, color: number, dashed = false) {
  const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const l = new THREE.Line(geo, dashed ? new THREE.LineDashedMaterial({ color, dashSize: 0.04, gapSize: 0.03, depthTest: false, transparent: true })
    : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
  if (dashed) l.computeLineDistances();
  return l;
}

export interface Toggle { id: string; a: P3; b: P3; on: boolean; label: string }

export function createMarker3d(scene: THREE.Scene) {
  const root = new THREE.Group(), pointer = new THREE.Group(), placed = new THREE.Group(), prev = new THREE.Group(), handles = new THREE.Group(), toggles = new THREE.Group();
  root.add(pointer, placed, prev, handles, toggles);
  scene.add(root);
  // the pointer: a ring flat on the surface, a short stem up from it, its height over the floor beside it
  const ringMat = basic(0xffffff), ring = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.045, 32), ringMat);
  const stem = line(new THREE.Vector3(), new THREE.Vector3(0, 0, 0.22), 0xffffff), dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 10, 8), basic(0xffffff));
  pointer.add(ring, stem, dot);
  pointer.visible = false;
  let hTag: THREE.Sprite | null = null, hText = '', promptTag: THREE.Sprite | null = null, promptText = '';
  const tagSlots: { sp: THREE.Sprite; text: string }[] = [];
  let pointsKey = '', handlesKey = '', hoverId: string | null = null;
  const hlist: { id: string; grp: THREE.Group; core: THREE.Mesh; ring: THREE.Mesh; label: THREE.Sprite; on: boolean; seed: number }[] = [];
  const camPos = new THREE.Vector3(), camQuat = new THREE.Quaternion();

  function reTag(old: THREE.Sprite | null, text: string, color: string, size = 0.035) {
    old?.removeFromParent(); old?.material.dispose();
    return text ? card(text.split('\n'), color, 'rgba(14,20,28,0.78)', size) : null;
  }
  const order = () => root.traverse(o => { o.renderOrder = 4; });   // over the splats, which don't write depth

  return {
    root,
    /** p: where the pointer meets the scan (null: off it); ok false: a point there would be refused (red); snapped:
     *  held to a flat level (filled ring) */
    setPointer(p: P3 | null, o: { ok?: boolean; snapped?: boolean; text?: string } = {}) {
      pointer.visible = !!p;
      if (!p) return;
      pointer.position.set(...p);
      const c = o.ok === false ? 0xff6b6b : o.snapped ? 0x7dff9a : 0xffffff;
      ringMat.color.setHex(c); (stem.material as THREE.LineBasicMaterial).color.setHex(c); ((dot.material) as THREE.MeshBasicMaterial).color.setHex(c);
      const t = o.text ?? `${Math.round(p[2] * 100)} cm up`;
      if (t !== hText) { hText = t; hTag = reTag(hTag, t, o.ok === false ? TEXT.bad : '#ffffff', 0.03); if (hTag) pointer.add(hTag); }
      hTag?.position.set(0, 0, 0.3);
      order();
    },
    /** the points placed so far, numbered */
    setPoints(ps: P3[]) {
      const key = JSON.stringify(ps);
      if (key === pointsKey) return;
      pointsKey = key;
      empty(placed);
      ps.forEach((p, k) => {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.022, 14, 10), basic(0xffd84d));
        s.position.set(...p);
        const n = card([`${k + 1}`], '#ffd84d', 'rgba(14,20,28,0.78)', 0.03);
        n.position.set(p[0], p[1], p[2] + 0.09);
        placed.add(s, n);
      });
      order();
    },
    setPreview(pv: Preview) {
      for (const c of [...prev.children]) if (!(c instanceof THREE.Sprite)) { prev.remove(c); (c as THREE.Line).geometry.dispose(); ((c as THREE.Line).material as THREE.Material).dispose(); }
      for (const l of pv.lines) prev.add(line(v3(l.a), v3(l.b), TONE[l.tone], l.tone === 'info' && l.a[2] !== l.b[2]));
      pv.tags.forEach((t, k) => {   // a sprite per slot, re-made only when its text changes (the pointer moves every frame)
        const slot = tagSlots[k], text = `${t.tone}|${t.text}`;
        if (!slot || slot.text !== text) {
          const sp = card([t.text], TEXT[t.tone], 'rgba(14,20,28,0.78)', t.tone === 'side' ? 0.05 : 0.035)!;
          if (slot) { slot.sp.removeFromParent(); slot.sp.material.dispose(); }
          tagSlots[k] = { sp, text }; prev.add(sp);
        }
        tagSlots[k].sp.position.set(...t.at); tagSlots[k].sp.visible = true;
      });
      for (let k = pv.tags.length; k < tagSlots.length; k++) tagSlots[k].sp.visible = false;
      order();
    },
    /** drag handles on measured stairs / doors; `owner` names the stair or door; active: the one being dragged. Each is a core, a
     *  ring that always faces you and pulses, and a tooltip on hover or drag; update() keeps their apparent size constant. */
    setHandles(hs: (Handle & { owner: string })[], active: string | null = null) {
      const key = JSON.stringify([hs, active]);
      if (key === handlesKey) return;
      handlesKey = key;
      empty(handles); hlist.length = 0;
      for (const h of hs) {
        const id = `${h.owner}:${h.key}`, grp = new THREE.Group(), userData = { owner: h.owner, key: h.key };
        grp.position.set(...h.at);
        const core = new THREE.Mesh(new THREE.SphereGeometry(0.026, 16, 12), basic(0x8fe3ff, 0.95));
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.052, 0.062, 40), basic(0x8fe3ff, 0.85));
        const halo = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), basic(0x8fe3ff, 0.1));   // a generous target for a laser pointer
        core.userData.handle = userData; halo.userData.handle = userData;
        const label = card([h.label, active === id ? 'release to place' : 'drag to move'], '#ffe27a', 'rgba(14,20,28,0.9)', 0.032);
        label.position.set(0, 0, 0.16); label.visible = false;
        grp.add(halo, core, ring, label);
        handles.add(grp);
        hlist.push({ id, grp, core, ring, label, on: active === id, seed: hlist.length * 1.7 });
      }
      order();
    },
    /** the handle under the pointer (`owner:key`), or null: it brightens and shows its tooltip */
    setHover(id: string | null) { hoverId = id; },
    /** per frame: a handle keeps the same size on screen (a 3 cm sphere at the far end of a landing was a speck), faces you, pulses */
    update(camera: THREE.Camera, t: number) {
      if (!hlist.length) return;
      camera.getWorldPosition(camPos); camera.getWorldQuaternion(camQuat);
      const calm = reducedMotion();
      for (const h of hlist) {
        const hot = h.on || hoverId === h.id, d = camPos.distanceTo(h.grp.position), s = Math.min(4.5, Math.max(0.8, d / 1.6)) * (hot ? 1.25 : 1);
        h.grp.scale.setScalar(s);
        h.ring.quaternion.copy(camQuat);   // the group is unrotated, so the world turn is the ring's own
        const pulse = calm ? 1 : 1 + 0.16 * Math.sin(t * 3.4 + h.seed);
        h.ring.scale.setScalar(pulse * (hot ? 1.2 : 1));
        const c = h.on ? 0xffd84d : hot ? 0xffffff : 0x8fe3ff;
        (h.core.material as THREE.MeshBasicMaterial).color.setHex(c); (h.ring.material as THREE.MeshBasicMaterial).color.setHex(c);
        (h.ring.material as THREE.MeshBasicMaterial).opacity = hot ? 0.95 : calm ? 0.8 : 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(t * 3.4 + h.seed));
        h.label.visible = hot;
      }
    },
    /** what is really at each side of a stair: click to say rail / no rail (teal = rail, dashed grey = none) */
    setToggles(ts: Toggle[]) {
      empty(toggles);
      for (const [k, t] of ts.entries()) {
        const a = v3(t.a), b = v3(t.b), path = new THREE.LineCurve3(a, b);
        const tube = new THREE.Mesh(new THREE.TubeGeometry(path, 8, t.on ? 0.018 : 0.01, 8, false), basic(t.on ? 0x2fd6c8 : 0x9aa4ae, t.on ? 0.85 : 0.5));
        const hit = new THREE.Mesh(new THREE.TubeGeometry(path, 8, 0.08, 6, false), basic(0xffffff, 0.0));   // invisible, wide: easy to click
        hit.userData.toggle = t.id; tube.userData.toggle = t.id;
        const tag = card([t.label], t.on ? '#7ff5e8' : '#c9d3dc', 'rgba(14,20,28,0.78)', 0.035);
        // Stagger the two sides along the flight: at an oblique view equal-height cards otherwise cover one another.
        tag.position.copy(a).lerp(b, k % 2 ? 0.6 : 0.2).add(new THREE.Vector3(0, 0, -0.12));
        toggles.add(tube, hit, tag);
      }
      order();
    },
    /** in the headset there is no status bar: the prompt floats near the pointer */
    setPrompt(text: string | null, at: P3 | null) {
      if ((text ?? '') !== promptText) { promptText = text ?? ''; promptTag = reTag(promptTag, promptText, '#ffe27a', 0.03); if (promptTag) root.add(promptTag); }
      if (promptTag) { promptTag.visible = !!at; if (at) promptTag.position.set(at[0], at[1], at[2] + 0.5); }
      order();
    },
    /** handle and toggle meshes, for the pointer ray */
    pickables: () => [...handles.children.flatMap(h => h.children.filter(c => c.userData.handle)), ...toggles.children.filter(c => c.userData.toggle && !(c instanceof THREE.Sprite))],
    clear() {
      pointsKey = ''; handlesKey = ''; hoverId = null; hlist.length = 0;
      pointer.visible = false; empty(placed); empty(handles); empty(toggles);
      this.setPreview({ lines: [], tags: [] });
      this.setPrompt(null, null);
    },
  };
}
