// Grounding the meshes in the scan. A splat room has its light baked in, so there is no light to cast shadows from and
// nothing for metal to reflect: the walker, cane and mannequin looked pasted on. Two fixes, both visual only:
// contact shadows (a soft dark blob where a leg, tip or foot meets the floor) and an environment map rendered from the
// splat itself (Spark's renderEnvMap), so the meshes pick up the room's own colour and brightness.
import * as THREE from 'three';
import type { SparkRenderer } from '@sparkjsdev/spark';
import type { WalkerCfg } from './walker.ts';

let tex: THREE.CanvasTexture | null = null;
/** radial falloff, dark centre to clear edge: (1 - t²)², broad in the middle and soft at the rim */
function blobTexture() {
  if (tex) return tex;
  const n = 64, c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d')!, grd = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  for (let k = 0; k <= 8; k++) grd.addColorStop(k / 8, `rgba(0,0,0,${((1 - (k / 8) ** 2) ** 2).toFixed(3)})`);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, n, n);
  tex = new THREE.CanvasTexture(c);
  return tex;
}

/** One shadow blob on the floor (z up), rx along x, ry along y. userData.shadow: recolouring passes skip it. */
export function blob(rx: number, ry = rx, strength = 0.5) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2 * rx, 2 * ry),
    new THREE.MeshBasicMaterial({ map: blobTexture(), color: 0x000000, transparent: true, opacity: strength, depthWrite: false }));
  m.position.z = 0.002;
  m.renderOrder = 2;   // after the splats (they don't write depth: drawn first, they would paint over the blob)
  m.userData.shadow = true;
  m.userData.strength = strength;
  return m;
}

/** Blobs under a device's legs (walker) or tip (cane), plus a faint one under the whole frame; in the device's own frame. */
export function groundDevice(group: THREE.Group, w: WalkerCfg) {
  const leg = w.leg_radius_m * 4.5;
  for (const [x, y] of w.legs) { const b = blob(leg, leg, 0.8); b.position.x = x; b.position.y = y; group.add(b); }
  if (w.device !== 'cane') {
    const b = blob(w.depth_m * 0.62, w.width_m * 0.58, 0.4);
    b.position.x = w.user_gap_m + w.depth_m / 2;
    group.add(b);
  }
  return group;
}

/** Shadows that follow the mannequin's feet (world frame, like its limbs): a foot lifted mid-swing casts a smaller,
 *  fainter blob. One soft blob under the body too, between the feet. */
export function footShadows(parent: THREE.Object3D) {
  const feet = [blob(0.16, 0.08, 0.75), blob(0.16, 0.08, 0.75)], body = blob(0.3, 0.26, 0.35);
  parent.add(...feet, body);
  return (bodyPose: { x: number; y: number; yaw: number }, pos: [number, number, number][]) => {
    feet.forEach((b, n) => {
      const [x, y, lift] = pos[n], k = Math.max(0.4, 1 - lift * 10);
      b.position.set(x + 0.05 * Math.cos(bodyPose.yaw), y + 0.05 * Math.sin(bodyPose.yaw), 0.002);   // the foot box sits ahead of the ankle
      b.rotation.z = bodyPose.yaw;
      b.scale.setScalar(k);
      (b.material as THREE.MeshBasicMaterial).opacity = b.userData.strength * k;
    });
    body.position.set(bodyPose.x, bodyPose.y, 0.002);
    body.rotation.z = bodyPose.yaw;
  };
}

/** Render the splat into an environment map from `at` (meshes hidden, so they don't reflect themselves) and light every
 *  standard material with it. Once at load: the cube render sorts and draws the splats six times. */
export async function roomEnvironment(spark: SparkRenderer, scene: THREE.Scene, at: THREE.Vector3) {
  const hide: THREE.Object3D[] = [];
  scene.traverse(o => {
    if (o === spark || !o.visible) return;   // splats are Object3Ds, not meshes: they stay
    if ((o as THREE.Mesh).isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) hide.push(o);
  });
  const env = await spark.renderEnvMap({ scene, worldCenter: at, hideObjects: hide, update: true });
  scene.environment = env;
  return env;
}
