// The small pill that names the picked (desktop) or pointed-at (VR) object. A Sprite, not DOM, so it shows in the headset.
import * as THREE from 'three';
import { card } from './reimagine.ts';

const PICKED_BG = 'rgba(16,52,86,0.92)', POINTED_BG = 'rgba(14,20,28,0.82)';   // picked: blue like the outline

export function createObjLabel(parent: THREE.Object3D) {
  let sprite: THREE.Sprite | null = null, key = '', target: THREE.Object3D | null = null;
  const box = new THREE.Box3(), top = new THREE.Vector3(), eye = new THREE.Vector3();
  const clear = () => { if (sprite) { sprite.removeFromParent(); sprite.material.dispose(); sprite = null; } key = ''; };   // the card cache owns the texture
  return {
    /** Name `obj` (its proxy box anchors the pill); null hides it. Cheap to call every frame: only a text change rebuilds. */
    set(obj: THREE.Object3D | null, lines: string[], picked: boolean) {
      target = obj;
      if (!obj) return clear();
      const k = `${picked}\n${lines.join('\n')}`;
      if (k === key) return;
      clear(); key = k;
      sprite = card(lines, picked ? '#ffffff' : '#e9f6ff', picked ? PICKED_BG : POINTED_BG, 0.06);
      parent.add(sprite);
    },
    /** Float above the object's top, and keep the same size on screen near or far. */
    update(camera: THREE.Camera) {
      if (!sprite || !target) return;
      box.setFromObject(target).getCenter(top);
      top.z = box.max.z + 0.18;
      sprite.position.copy(top);
      const s = THREE.MathUtils.clamp(camera.getWorldPosition(eye).distanceTo(top) / 2.5, 0.5, 2.2);
      sprite.scale.copy(sprite.userData.base).multiplyScalar(s);
    },
  };
}
