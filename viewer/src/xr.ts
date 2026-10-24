// WebXR, behind ?xr=1 (infrastructure; not needed for the demo). The headset becomes the patient's eyes: the rig sits
// on the walker user's spot, the left thumbstick walks (forward/back) and turns, with the same wall and coverage
// checks as free walk. The scene is z-up and WebXR is y-up, so the rig turns y-up into z-up and faces the body's yaw.
// On a Quest: `adb reverse tcp:5179 tcp:5179`, then open http://localhost:5179/?xr=1 (localhost counts as secure).
import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

export function setupXR(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  const rig = new THREE.Group();
  scene.add(rig);
  const button = VRButton.createButton(renderer);
  button.id = 'vrbutton';
  document.body.appendChild(button);
  const upZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);   // XR y-up -> scene z-up
  const yawQ = new THREE.Quaternion(), zAxis = new THREE.Vector3(0, 0, 1);
  renderer.xr.addEventListener('sessionstart', () => { rig.add(camera); camera.position.set(0, 0, 0); camera.quaternion.identity(); });
  renderer.xr.addEventListener('sessionend', () => { scene.add(camera); });
  let snapCooldown = 0;
  return {
    presenting: () => renderer.xr.isPresenting,
    /** Put the rig (floor, under the user) on the body; headset forward (XR -z) points along the body's yaw. */
    place(body: { x: number; y: number; yaw: number }) {
      rig.position.set(body.x, body.y, 0);
      rig.quaternion.copy(yawQ.setFromAxisAngle(zAxis, body.yaw - Math.PI / 2)).multiply(upZ);
    },
    /** Left thumbstick as keys for free walk (W/S) and a 30-degree snap turn on a flick. Returns the turn (rad). */
    input(keys: Set<string>, dt: number): number {
      const session = renderer.xr.getSession();
      keys.delete('KeyW'); keys.delete('KeyS');
      if (!session) return 0;
      let turn = 0;
      snapCooldown = Math.max(0, snapCooldown - dt);
      for (const src of session.inputSources) {
        const ax = src.gamepad?.axes;
        if (!ax || src.handedness !== 'left') continue;
        const [x, y] = ax.length >= 4 ? [ax[2], ax[3]] : [ax[0], ax[1]];
        if (y < -0.5) keys.add('KeyW');
        if (y > 0.5) keys.add('KeyS');
        if (Math.abs(x) > 0.7 && !snapCooldown) { turn = -Math.sign(x) * Math.PI / 6; snapCooldown = 0.35; }
      }
      return turn;
    },
  };
}
