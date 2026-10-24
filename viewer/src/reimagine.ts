// The reimagined room: the room as it is morphing into the layout on screen (suggested or dragged by hand). Every
// changed object glides from where it stands now to where it should go, leaves a ghost outline at its old spot, and
// carries a tag with what the change takes (movecost.ts); hazards the change clears turn green. Everything drawn here
// is a scene object (sprites, lines, meshes), never DOM or CSS2D, so it shows in the headset too. The animation is
// visual only: the numbers are always the layout on screen. Pure helpers on top are tested in node.
import * as THREE from 'three';
import type { Intervention, Layout, Pose, XY } from './grid.ts';
import { fixCost, moveCost, removeCost, sumCosts, type MoveCost } from './movecost.ts';

export interface Change {
  /** object index (-1: a fix with no object, e.g. taped cable) */
  k: number; name: string; kind: 'move' | 'remove' | 'fix'; label: string;
  from?: Pose; to?: Pose; dist_m: number; turn_deg: number; at: XY; cost: MoveCost;
  /** height of an added fixture (a rail up the stairs), for its tag */
  z?: number;
  /** the configured fix behind it, if any */
  iv?: string;
}
type Obj = { name: string; kind: string; pivot: number[]; height_m?: number };

const turnDeg = (a: number, b: number) => Math.round(Math.abs((Math.atan2(Math.sin(b - a), Math.cos(b - a)) * 180) / Math.PI));
const sameBox = (a: [XY, XY], b: [XY, XY]) => a.every((p, n) => Math.abs(p[0] - b[n][0]) < 1e-6 && Math.abs(p[1] - b[n][1]) < 1e-6);

/** Every difference between two layouts, objects first. A change made by a configured fix in `applied` is costed and
 *  labelled by that fix; anything else (optimizer moves, hand drags) by movecost.ts. */
export function diffLayouts(objs: Obj[], from: Layout, to: Layout, interventions: Intervention[] = [], applied: string[] = []): Change[] {
  const ivs = interventions.filter(iv => applied.includes(iv.id)), out: Change[] = [];
  objs.forEach((o, k) => {
    const a = from.poses[k], b = to.poses[k], iv = ivs.find(i => i.object === o.name);
    const via = iv ? { label: iv.label, cost: fixCost(iv), iv: iv.id } : null;
    if (b.removed && !a.removed) {
      out.push({ k, name: o.name, kind: 'remove', label: via?.label ?? `Take the ${o.name} out of the room`, from: a, dist_m: 0, turn_deg: 0,
        at: [a.x, a.y], cost: via?.cost ?? removeCost(o), iv: via?.iv });
      return;
    }
    if (b.removed || a.removed) return;
    const d = Math.hypot(b.x - a.x, b.y - a.y), t = turnDeg(a.yaw, b.yaw);
    if (d < 0.02 && t < 1) return;
    out.push({ k, name: o.name, kind: 'move', label: via?.label ?? `Move the ${o.name} ${d.toFixed(1)} m${t ? `, turned ${t}°` : ''}`,
      from: a, to: b, dist_m: d, turn_deg: t, at: [b.x, b.y], cost: via?.cost ?? moveCost(o, a, b), iv: via?.iv });
  });
  // fixes with no object to move: taped strips, raised seats, added fixtures
  const fixOnly = (iv: Intervention, at: XY) => out.push({ k: -1, name: iv.target ?? iv.id, kind: 'fix', label: iv.label, dist_m: 0, turn_deg: 0, at, z: iv.fixture?.xyz?.[2], cost: fixCost(iv), iv: iv.id });
  for (const box of to.flattened) {
    if (from.flattened.some(f => sameBox(f, box))) continue;
    const iv = interventions.find(i => i.kind === 'flatten' && i.box_xy && sameBox(i.box_xy, box));
    const at: XY = [(box[0][0] + box[1][0]) / 2, (box[0][1] + box[1][1]) / 2];
    if (iv) fixOnly(iv, at);
  }
  for (const [target, by] of Object.entries(to.raised ?? {})) {
    if (Math.abs(by - (from.raised?.[target] ?? 0)) < 1e-6) continue;
    const iv = interventions.find(i => i.kind === 'raise' && i.target === target), o = objs.find(x => x.name === target);
    if (iv) fixOnly(iv, o ? [o.pivot[0], o.pivot[1]] : [0, 0]);
  }
  for (const id of to.added ?? []) {
    if (from.added?.includes(id)) continue;
    const iv = interventions.find(i => i.id === id), k = objs.findIndex(x => x.name === iv?.fixture?.attach), p = to.placed?.[id];
    const xyz = p ? [p.x, p.y] : iv?.fixture?.xyz;
    if (iv) {
      fixOnly(iv, k >= 0 ? [to.poses[k].x, to.poses[k].y] : xyz ? [xyz[0], xyz[1]] : [0, 0]);
      if (p && iv.fixture?.xyz) out[out.length - 1].label += `; parked ${Math.hypot(p.x - iv.fixture.xyz[0], p.y - iv.fixture.xyz[1]).toFixed(1)} m from its suggested spot`;
    }
  }
  for (const c of to.carved ?? []) {   // a widened doorway: tag it at the opening, at head height
    if (from.carved?.some(f => f.id === c.id)) continue;
    const iv = interventions.find(i => i.id === c.id), P = c.poly;
    if (iv) out.push({ k: -1, name: c.target, kind: 'fix', label: iv.label, dist_m: 0, turn_deg: 0, z: 1.6, iv: iv.id, cost: fixCost(iv),
      at: [P.reduce((a, p) => a + p[0], 0) / P.length, P.reduce((a, p) => a + p[1], 0) / P.length] });
  }
  return out;
}

/** The layout with one change taken back (the object to where it stood, or the fix off). */
export function undoChange(lay: Layout, original: Pose[], c: Change, interventions: Intervention[]): Layout {
  const poses = lay.poses.map((p, n) => (n === c.k ? { ...original[n] } : p));
  const iv = interventions.find(i => i.id === c.iv);
  let { flattened, raised, added } = lay;
  if (iv?.kind === 'flatten' && iv.box_xy) flattened = flattened.filter(b => !sameBox(b, iv.box_xy!));
  if (iv?.kind === 'raise' && raised) { raised = { ...raised }; delete raised[iv.target!]; }
  if (iv?.kind === 'add' && added) added = added.filter(id => id !== iv.id);
  const carved = lay.carved?.filter(x => x.id !== c.iv);
  const placed = lay.placed && iv?.kind === 'add' ? Object.fromEntries(Object.entries(lay.placed).filter(([id]) => id !== iv.id)) : lay.placed;   // taken off: put back, it starts at its default spot
  return { ...lay, poses, flattened, raised, added, ...(carved ? { carved } : {}), ...(placed ? { placed } : {}) };
}

const smooth = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };
/** Eased pose between two poses; yaw turns the short way. */
export function poseAt(a: Pose, b: Pose, t: number): Pose {
  const s = smooth(t), dy = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
  return { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s, yaw: a.yaw + dy * s };
}
/** Local progress of item i of n when they move one after another, each starting halfway through the previous. */
export function stagger(t: number, i: number, n: number): number {
  if (n <= 1) return Math.min(1, Math.max(0, t));
  const w = 1 / (1 + 0.5 * (n - 1)), start = i * 0.5 * w;
  return Math.min(1, Math.max(0, (t - start) / w));
}

type Hz = { type: string; position: XY; name?: string };
/** Which hazards of the room as it is are gone in the reimagined one (same type within `tol` metres). */
export function hazardDiff<H extends Hz>(before: H[], after: H[], tol = 0.4) {
  const near = (a: Hz, b: Hz) => a.type === b.type && Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1]) <= tol;
  return { resolved: before.filter(h => !after.some(x => near(h, x))), remaining: after.filter(h => before.some(x => near(h, x))),
    added: after.filter(h => !before.some(x => near(h, x))) };
}

/** Short words for a cost tag. */
export function costText(c: MoveCost): string {
  return [c.usd ? `$${c.usd}` : 'free', `${c.minutes} min`, c.helpers > 1 ? `${c.helpers} people` : ''].filter(Boolean).join(' · ');
}

// ---------- three.js: the overlays and the morph ----------

// card textures by content: every refresh redraws every tag, and most of them read the same as last time
const cardCache = new Map<string, { tex: THREE.CanvasTexture; w: number; h: number }>();
/** A text card as a sprite (world-sized, always on top): readable on a monitor and in the headset. */
export function card(lines: string[], color = '#e9f6ff', bg = 'rgba(14,20,28,0.82)', lineH = 0.075): THREE.Sprite {
  const key = [color, bg, ...lines].join('\n'), hit = cardCache.get(key);
  if (hit) return cardSprite(hit, lines.length, lineH);
  if (cardCache.size > 120) { for (const c of cardCache.values()) c.tex.dispose(); cardCache.clear(); }
  const px = 44, pad = 18, cv = document.createElement('canvas'), ctx = cv.getContext('2d')!;
  ctx.font = `600 ${px}px system-ui, sans-serif`;
  const w = Math.ceil(Math.max(...lines.map(l => ctx.measureText(l).width))) + pad * 2, h = lines.length * px * 1.25 + pad * 2;
  cv.width = w; cv.height = h;
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.roundRect(0, 0, w, h, 22); ctx.fill();
  ctx.font = `600 ${px}px system-ui, sans-serif`; ctx.textBaseline = 'top';
  lines.forEach((l, n) => { ctx.fillStyle = n === 0 ? color : '#c9d3dc'; ctx.fillText(l, pad, pad + n * px * 1.25); });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const entry = { tex, w, h };
  cardCache.set(key, entry);
  return cardSprite(entry, lines.length, lineH);
}
function cardSprite({ tex, w, h }: { tex: THREE.CanvasTexture; w: number; h: number }, n: number, lineH: number): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true }));
  const H = lineH * n * 1.25 + 0.04;
  s.scale.set((H * w) / h, H, 1);
  s.userData.base = s.scale.clone();
  s.renderOrder = 3;
  return s;
}
function dispose(grp: THREE.Object3D) {
  for (const c of [...grp.children]) {
    grp.remove(c);
    c.traverse(x => {
      const m = x as THREE.Mesh;
      if (m.userData.shared) return;   // the rings' geometry and materials live as long as the room
      m.geometry?.dispose();
      for (const mat of [m.material].flat() as THREE.Material[]) mat?.dispose();   // card textures are cached, not owned
    });
  }
}

export interface Item { group: THREE.Group; proxy: THREE.Mesh; mesh: { opacity: number }; fill: { visible: boolean }; tag: { visible: boolean } }
export interface ReimagineDeps {
  scene: THREE.Scene; items: Item[]; objs: Obj[]; original: Pose[]; interventions: Intervention[];
  /** room centre, for the floating receipt */
  centre: XY;
  /** put every object where the layout on screen says (main.ts syncObjects): the end state of the morph */
  sync: () => void;
  /** may the imagined fill under a moved object show (the "imagined floor" toggle) */
  fillsOn: () => boolean;
  onT?: (t: number) => void;
  /** to keep tags from swelling when you stand next to them */
  camera?: THREE.Camera;
}
/** Which parts of the overlay are drawn. Tags are the per-change cost cards; 'selected' shows only the picked change's. */
export interface Parts { ghosts: boolean; arrows: boolean; tags: 'all' | 'selected' | 'off'; receipt: boolean; rings: boolean; ringLabels: boolean }
export const ALL_PARTS: Parts = { ghosts: true, arrows: true, tags: 'selected', receipt: true, rings: true, ringLabels: true };
type Eh = Hz & { height_m?: number; min_side_clearance_m?: number };

export function createReimagine(D: ReimagineDeps) {
  const root = new THREE.Group(), ghosts = new THREE.Group(), arrows = new THREE.Group(), tags = new THREE.Group(), receipt = new THREE.Group(), marks = new THREE.Group();
  root.add(ghosts, arrows, tags, receipt, marks);
  const ringGeo = new THREE.RingGeometry(0.2, 0.27, 40);
  const ringMat = { fixed: new THREE.MeshBasicMaterial({ color: 0x2fbf5f, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }),
    new: new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }) };
  let parts: Parts = { ...ALL_PARTS }, picked = -1;
  root.renderOrder = 3;
  D.scene.add(root);
  let changes: Change[] = [], t = 1, anim: { dur: number } | null = null;
  let resolved: Eh[] = [], added: Eh[] = [];
  let lastBA: [{ per_month: number; hazards: Eh[] } | null, { per_month: number; hazards: Eh[] } | null] | null = null;

  const hzText = (h: Eh) => h.type === 'floor_bump' ? `${h.name ?? 'bump'} ${h.height_m !== undefined ? `${(h.height_m * 100).toFixed(1)} cm` : ''}`
    : `squeeze ${h.min_side_clearance_m !== undefined ? `${(h.min_side_clearance_m * 100).toFixed(0)} cm/side` : ''}`;

  function build(before: { per_month: number; hazards: Eh[] } | null, after: { per_month: number; hazards: Eh[] } | null) {
    dispose(ghosts); dispose(arrows); dispose(tags); dispose(receipt); dispose(marks);
    for (const c of changes) {
      const it = c.k >= 0 ? D.items[c.k] : null, o = c.k >= 0 ? D.objs[c.k] : null;
      if (it && c.from) {   // dashed outline where it stands now
        const gh = new THREE.Group();
        gh.position.set(c.from.x, c.from.y, 0); gh.rotation.z = c.from.yaw;
        const line = new THREE.LineSegments(new THREE.EdgesGeometry(it.proxy.geometry),
          new THREE.LineDashedMaterial({ color: 0xb8c4ce, dashSize: 0.06, gapSize: 0.04, transparent: true, opacity: 0, depthTest: false }));
        line.position.copy(it.proxy.position); line.rotation.copy(it.proxy.rotation);
        line.computeLineDistances();
        line.renderOrder = 3;
        gh.add(line);
        gh.userData.change = c;
        ghosts.add(gh);
      }
      if (c.kind === 'move' && c.from && c.to && c.dist_m > 0.05) {   // floor arrow, old spot -> new spot
        const dir = new THREE.Vector3(c.to.x - c.from.x, c.to.y - c.from.y, 0);
        const arrow = new THREE.ArrowHelper(dir.clone().normalize(), new THREE.Vector3(c.from.x, c.from.y, 0.04), dir.length(), 0x5fd0ff, 0.14, 0.09);
        arrow.traverse(x => { const m = (x as THREE.Mesh).material as THREE.Material | undefined; if (m) { m.depthTest = false; m.transparent = true; } x.renderOrder = 3; });
        arrows.add(arrow);
      }
      const tag = card([c.label, costText(c.cost)], c.kind === 'remove' ? '#ffd27a' : '#8fe3ff', undefined, 0.055);
      tag.position.set(c.at[0], c.at[1], Math.max(0.65, (o?.height_m ?? 0) + 0.35, (c.z ?? 0) + 0.4));   // above the hazard labels (0.15)
      tag.userData.k = c.k;
      tags.add(tag);
    }
    resolved = []; added = [];
    if (before && after && changes.length) ({ resolved, added } = hazardDiff(before.hazards, after.hazards));
    for (const [list, word] of [[resolved, 'fixed'], [added, 'new']] as const)
      for (const h of list) {
        const ring = new THREE.Mesh(ringGeo, ringMat[word]);
        ring.position.set(h.position[0], h.position[1], 0.045);
        ring.renderOrder = 3;
        ring.userData.shared = true;
        if (parts.ringLabels) {
          const s = card([`${word}: ${hzText(h)}`], word === 'fixed' ? '#7dffa8' : '#ff9a9a', 'rgba(14,20,28,0.75)', 0.045);
          s.position.set(0, 0, 0.15);
          ring.add(s);
        }
        ring.userData.word = word;
        marks.add(ring);
      }
    if (changes.length) {   // the receipt over the middle of the room
      const tot = sumCosts(changes.map(c => c.cost));
      const lines = ['Reimagined room', `${changes.length} change${changes.length === 1 ? '' : 's'} · ${tot.usd ? `$${tot.usd}` : 'no purchases'} · ${tot.minutes} min`];
      if (before && after) lines.push(`toe contacts/month ${before.per_month.toFixed(2)} → ${after.per_month.toFixed(2)}`);
      if (resolved.length) lines.push(`${resolved.length} hazard${resolved.length === 1 ? '' : 's'} cleared`);
      if (changes.some(c => c.cost.source === 'placeholder')) lines.push('costs: placeholder estimates');
      const r = card(lines, '#ffffff', 'rgba(14,20,28,0.85)', 0.09);
      r.position.set(D.centre[0], D.centre[1], 1.9);
      receipt.add(r);
    }
    applyParts();
  }

  function applyParts() {
    ghosts.visible = parts.ghosts; arrows.visible = parts.arrows; receipt.visible = parts.receipt; marks.visible = parts.rings;
    tags.visible = parts.tags !== 'off';
    for (const s of tags.children) s.visible = parts.tags === 'all' || s.userData.k < 0 || s.userData.k === picked;   // a fix with no object has nothing to click: its tag stays
  }

  /** 0 = the room as it is, 1 = reimagined. */
  function setT(v: number) {
    t = Math.min(1, Math.max(0, v));
    const moving = changes.filter(c => c.k >= 0);
    if (t >= 1) {
      for (const c of moving) D.items[c.k].mesh.opacity = 1;
      D.sync();
    } else moving.forEach((c, i) => {
      const it = D.items[c.k], u = stagger(t, i, moving.length);
      if (c.kind === 'move') {
        const p = poseAt(c.from!, c.to!, u);
        it.group.position.set(p.x, p.y, 0); it.group.rotation.z = p.yaw;
        it.group.visible = true; it.mesh.opacity = 1;
      } else {   // carried out: fades away
        it.group.position.set(c.from!.x, c.from!.y, 0); it.group.rotation.z = c.from!.yaw;
        it.group.visible = u < 1; it.mesh.opacity = 1 - smooth(u);
      }
      it.fill.visible = it.tag.visible = u > 0.5 && D.fillsOn();   // the spot it leaves was never filmed
    });
    moving.forEach((c, i) => {   // ghosts appear as the object leaves
      const u = stagger(t, i, moving.length);
      for (const gh of ghosts.children) if (gh.userData.change === c) gh.traverse(x => { const m = (x as THREE.LineSegments).material as THREE.Material; if (m) m.opacity = 0.9 * smooth(u * 2); });
    });
    ringMat.fixed.opacity = ringMat.new.opacity = 0.85 * smooth((t - 0.6) / 0.4);
    D.onT?.(t);
  }

  return {
    root,
    /** Recompute the changes (room as filmed -> `lay`) and redraw; before/after evals give the hazard diff. */
    refresh(lay: Layout, applied: string[], before: { per_month: number; hazards: Eh[] } | null, after: { per_month: number; hazards: Eh[] } | null) {
      const from: Layout = { poses: D.original, flattened: [] };
      changes = diffLayouts(D.objs, from, lay, D.interventions, applied);
      lastBA = [before, after];
      build(before, after);
      if (!anim) setT(1);
      return changes;
    },
    changes: () => changes,
    resolved: () => resolved,
    setT(v: number) { anim = null; setT(v); return t; },
    t: () => t,
    play(seconds = 3) { anim = { dur: Math.max(0.1, seconds) }; setT(0); },
    playing: () => !!anim,
    /** per frame */
    update(dt: number) {
      if (D.camera && root.visible)
        for (const grp of [tags, receipt]) if (grp.visible)
          for (const s of grp.children as THREE.Sprite[]) if (s.visible && s.userData.base)   // shrink up close: a card at arm's length filled the view
            s.scale.copy(s.userData.base).multiplyScalar(Math.min(1, Math.max(0.3, D.camera.position.distanceTo(s.position) / 2.5)));
      if (!anim) return;
      setT(t + dt / anim.dur);
      if (t >= 1) anim = null;
    },
    setVisible(on: boolean) { root.visible = on; },
    /** show or hide parts of the overlay (the panel's checkboxes, performance mode) */
    setParts(p: Partial<Parts>) {
      const labels = parts.ringLabels;
      parts = { ...parts, ...p };
      if (parts.ringLabels !== labels) build(lastBA?.[0] ?? null, lastBA?.[1] ?? null); else applyParts();
    },
    parts: () => parts,
    /** the object whose cost tag shows when tags are 'selected' (-1: none) */
    selectChange(k: number) { picked = k; applyParts(); },
  };
}
export type Reimagine = ReturnType<typeof createReimagine>;
