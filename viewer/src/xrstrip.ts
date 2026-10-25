// The controls strip on the off-hand controller (VR): the mode's name, then one row per action with its button as a pill.
// Its own canvas (not reimagine.ts card()) so the text is big and the card is narrow: card() put every key on one line,
// which made a card a few times wider than the controller and its letters small. Sizes are pixels on the canvas; M_PER_PX
// turns them into metres so a row reads about 3 cm tall at arm's length.
import * as THREE from 'three';

export const M_PER_PX = 0.00055;
export const STRIP_PAD = 22, STRIP_HEAD_PX = 66, STRIP_ROW_PX = 94, STRIP_MIN_W = 440;
export interface StripRow { key: string; text: string }

/** Canvas size for a label and rows, given the measured widths of each row's key pill and action. Pure so tests can run it. */
export function stripSize(rows: { keyW: number; textW: number }[], labelW: number): { w: number; h: number } {
  const rowW = Math.max(0, ...rows.map(r => r.keyW + 24 + r.textW));
  return { w: Math.ceil(Math.max(STRIP_MIN_W, labelW, rowW) + STRIP_PAD * 2), h: STRIP_PAD * 2 + STRIP_HEAD_PX + rows.length * STRIP_ROW_PX };
}

const cache = new Map<string, { tex: THREE.CanvasTexture; w: number; h: number }>();

export function stripSprite(label: string, rows: StripRow[], color: string): THREE.Sprite {
  const key = [color, label, ...rows.map(r => `${r.key}\t${r.text}`)].join('\n');
  let hit = cache.get(key);
  if (!hit) {
    if (cache.size > 40) { for (const c of cache.values()) c.tex.dispose(); cache.clear(); }
    const cv = document.createElement('canvas'), c = cv.getContext('2d')!;
    const font = (px: number, weight = 600) => `${weight} ${px}px system-ui, sans-serif`;
    c.font = font(42, 700); const labelW = c.measureText(label).width;
    c.font = font(50, 700); const keyW = rows.map(r => c.measureText(r.key).width + 40);
    c.font = font(56, 600); const textW = rows.map(r => c.measureText(r.text).width);
    const { w, h } = stripSize(rows.map((_, i) => ({ keyW: keyW[i], textW: textW[i] })), labelW);
    cv.width = w; cv.height = h;
    c.fillStyle = 'rgba(8,12,18,0.95)'; c.strokeStyle = color; c.lineWidth = 6;
    c.beginPath(); c.roundRect(3, 3, w - 6, h - 6, 30); c.fill(); c.stroke();
    c.textBaseline = 'middle'; c.textAlign = 'left';
    c.font = font(42, 700); c.fillStyle = color; c.fillText(label, STRIP_PAD, STRIP_PAD + STRIP_HEAD_PX / 2, w - STRIP_PAD * 2);
    rows.forEach((r, i) => {
      const y = STRIP_PAD + STRIP_HEAD_PX + i * STRIP_ROW_PX + STRIP_ROW_PX / 2;
      c.fillStyle = 'rgba(255,255,255,0.14)'; c.strokeStyle = color; c.lineWidth = 4;
      c.beginPath(); c.roundRect(STRIP_PAD, y - 34, keyW[i], 68, 18); c.fill(); c.stroke();
      c.font = font(50, 700); c.fillStyle = '#ffffff'; c.textAlign = 'center'; c.fillText(r.key, STRIP_PAD + keyW[i] / 2, y + 2);
      c.font = font(56, 600); c.fillStyle = '#f2f7fb'; c.textAlign = 'left'; c.fillText(r.text, STRIP_PAD + keyW[i] + 24, y + 2);
    });
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    hit = { tex, w, h }; cache.set(key, hit);
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: hit.tex, depthTest: false, depthWrite: false, transparent: true }));
  s.scale.set(hit.w * M_PER_PX, hit.h * M_PER_PX, 1);
  s.renderOrder = 4;
  return s;
}
