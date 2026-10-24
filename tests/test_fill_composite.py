"""Cosmos-fill compositing (no GPU): the real frame stays outside the hole, Cosmos's pixels go inside with their
exposure matched to the real frame around the hole.  .venv/bin/python tests/test_fill_composite.py"""
import sys
from pathlib import Path
import numpy as np

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / "cosmos")]
from fill_object import composite, orbit

H, W = 120, 160
render = np.full((H, W, 3), [0.6, 0.45, 0.3])           # a wooden floor, the hole painted black by the controls
mask = np.zeros((H, W), bool); mask[40:80, 60:100] = True
render[mask] = 0
cosmos = np.full((H, W, 3), [0.8, 0.65, 0.5])            # Cosmos: the same floor but brighter, with a plank line
cosmos[:, 78:82] *= 0.7
out = composite(render, cosmos, mask)
far = np.zeros((H, W), bool); far[:10] = True
assert np.allclose(out[far], render[far]), "the real frame is untouched away from the hole"
assert np.allclose(out[60, 70], [0.6, 0.45, 0.3], atol=0.03), out[60, 70]     # exposure matched to the ring around the hole
assert out[60, 80].mean() < out[60, 70].mean() - 0.03, "Cosmos's texture survives the matching"

# orbit: a bed against the wall (y = 3.95) of a 4 x 4 m room: every camera stands inside, clear of the walls, looks at it
free = lambda x, y: 0.25 <= x <= 3.75 and 0.25 <= y <= 3.75
cams = orbit([0.9, 2.9], free)
eyes = np.array([-c[:3, :3].T @ c[:3, 3] for c in cams])
assert len(cams) == 93 and all(free(x, y) for x, y, _ in eyes), eyes[[0, -1]]
ang = np.unwrap(np.arctan2(eyes[:, 1] - 2.9, eyes[:, 0] - 0.9))
assert abs(ang[-1] - ang[0]) >= np.radians(90), np.degrees(ang[-1] - ang[0])
fwd = np.array([c[2, :3] for c in cams])   # camera z axis in world: looks at the spot
to = np.array([0.9, 2.9, 0.0]) - eyes
assert (np.einsum("ij,ij->i", fwd, to / np.linalg.norm(to, axis=1)[:, None]) > 0.999).all()
print("FILL COMPOSITE OK")
