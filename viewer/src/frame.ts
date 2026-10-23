// THE one place for the axis convention.
// The pipeline's floor frame is metres, floor at z=0, +z up. Instead of converting every splat, grid and path to
// three.js's usual y-up, the viewer runs three in that frame: DEFAULT_UP = +z (set before any camera exists), so
// PLYs, grids, routes and hazards load untouched. Cameras saved to JSON (clips, Cosmos jobs) use the Python side's
// OpenCV convention (world->camera, x right, y down, z forward), the same as stages/09_fix_render.look_at.
import * as THREE from 'three';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const CV_FROM_GL = new THREE.Matrix4().makeScale(1, -1, -1);   // three camera looks down -z with +y up

/** three.js camera -> OpenCV world-to-camera 4x4 (row-major nested arrays, like the Python JSON). */
export function cameraToW2C(cam: THREE.Camera): number[][] {
  cam.updateMatrixWorld();
  const c2w = cam.matrixWorld.clone().multiply(CV_FROM_GL);
  const e = c2w.invert().elements;               // column-major
  return [0, 1, 2, 3].map(r => [0, 1, 2, 3].map(c => e[c * 4 + r]));
}

/** OpenCV intrinsics for a perspective camera rendered at width x height. */
export function intrinsics(cam: THREE.PerspectiveCamera, width: number, height: number): number[][] {
  const f = height / 2 / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
  return [[f, 0, width / 2], [0, f, height / 2], [0, 0, 1]];
}

/** Project a floor-frame point with an OpenCV w2c + K; null if behind the camera. */
export function projectCV(w2c: number[][], K: number[][], p: number[]): [number, number] | null {
  const x = [0, 1, 2].map(r => w2c[r][0] * p[0] + w2c[r][1] * p[1] + w2c[r][2] * p[2] + w2c[r][3]);
  if (x[2] <= 1e-6) return null;
  return [K[0][0] * x[0] / x[2] + K[0][2], K[1][1] * x[1] / x[2] + K[1][2]];
}
