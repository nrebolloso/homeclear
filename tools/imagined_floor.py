"""Imagined floor where the scan saw none. A plain landing gives the splat nothing to track, so its middle never
reconstructed (newell_stair: 69% of the landing under half covered) and the viewer shows the stairwell through it. Each
clean.lighter_imagined_floor box {center, size, yaw_deg} (floor frame; center z = a little under the floor) becomes a
sheet of flat 1 cm discs (stage 12b's gaussians) in the median colour of the opaque Gaussians within BAND of it: the real
floor stays on top, the sheet shows only through its gaps. Writes <scene>/imagined_floor.ply and points scene.json's
imagined_floor at it; the viewer tints it as imagined. clean.lighter_imagined_steps entries {flight, risers: [n per
gap], under_m?} add even steps (treads and risers) between a game.stairs flight's seen treads and up to its top, where
the scan saw almost nothing (newell flight B); under_m adds an underside and side faces, so the flight reads solid from
beside and below. Run after lighter_trim, and again after any re-export.
  python tools/imagined_floor.py <config.yaml> viewer/public/scene/<run>_lighter
"""
import importlib, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import read_ply, write_ply, ply_xyz
from tools.lighter_clean import in_box
import numpy as np
import yaml

fills = importlib.import_module("stages.12b_fills")
BAND = 0.1   # the landing's splats scatter +-6 cm around its height (scene.json bump_note)
RISER_SHADE = 0.7   # risers darker than treads, as the scan's own steps render; one flat colour reads as a ramp


def sheet(v, p, b):
    """(pts, rgb) of the discs for box b. Its faint Gaussians store paler colours than the floor renders (median 0.74 vs
    0.70 on the Newell landing), so only opaque ones set the colour."""
    c, s, a = np.array(b["center"], float), np.array(b["size"], float), np.radians(b.get("yaw_deg", 0))
    near = in_box(p, {**b, "size": [*s, 2 * BAND]}) & (fills.opacity_of(v) > 0.5)
    u, w = np.meshgrid(*[np.arange(fills.PX / 2, L, fills.PX) - L / 2 for L in s])
    xy = np.c_[u.ravel() * np.cos(a) - w.ravel() * np.sin(a), u.ravel() * np.sin(a) + w.ravel() * np.cos(a)] + c[:2]
    pts = np.c_[xy, np.full(len(xy), c[2])]
    assert in_box(pts, {**b, "size": [*(s + 1e-6), 1e-6]}).all(), "sheet left its box (yaw sign?)"
    return pts, np.tile(np.median(fills.rgb_of(v[near]), 0), (len(xy), 1))


def steps(v, p, f, risers, under=None):
    """Gaussians of even steps over flight f: risers[i] of them from seen tread i up to the next one (the last from the
    last seen tread up to top_z at the flight's top). Each tread a sheet 1 cm under its height, each riser a wall of discs
    at its front, in the lower seen tread's colour (risers shaded). under (m): also an underside sheet that far below the
    line from bottom_z to top_z and side faces from it up to the treads, so the flight reads solid from beside and below."""
    b0, top = np.mean(f["bottom"], 0), np.array(f["top"])
    u = (top - b0) / np.linalg.norm(top - b0); side = np.array([-u[1], u[0]]); yaw = np.degrees(np.arctan2(u[1], u[0]))
    fronts, zs = [*f["tread_fronts_m"], np.linalg.norm(top - b0)], [*f["treads_z"], f["top_z"]]
    assert len(risers) <= len(f["treads_z"]), "more step runs than gaps between seen treads"
    out, st, hz = [], [], []   # each tread's start along the run and its height, for the side faces
    for i, n in enumerate(risers):
        s0, z0 = fronts[i], zs[i]
        g, r = (fronts[i + 1] - s0) / n, (zs[i + 1] - z0) / n
        tr = [sheet(v, p, {"center": [*(b0 + u * (s0 + (k + 0.5) * g)), z0 + k * r - 0.01], "size": [g, f["width_m"]], "yaw_deg": yaw}) for k in range(n)]
        pts = np.concatenate([t[0] for t in tr])
        w, h = np.meshgrid(np.arange(fills.PX / 2, f["width_m"], fills.PX) - f["width_m"] / 2, np.arange(fills.PX / 2, r, fills.PX))
        rise = np.concatenate([np.c_[b0 + u * (s0 + k * g) + np.outer(w.ravel(), side), z0 + (k - 1) * r + h.ravel()] for k in range(1, n + 1)])
        rgb = tr[0][1][0]
        assert np.isfinite(rgb).all(), f"no opaque Gaussians at seen tread {i} to take a colour from"
        st += [s0 + k * g for k in range(n)]; hz += [z0 + k * r for k in range(n)]
        out += [fills.gaussians(v.dtype, pts, np.tile(rgb, (len(pts), 1)), 2),
                fills.gaussians(v.dtype, rise, np.tile(rgb * RISER_SHADE, (len(rise), 1)), int(abs(u[1]) > abs(u[0])))]   # risers: flat along the run's main axis
    if under:   # ASSUMED waist: the scan has nothing under the flight or beside it
        L, W = fronts[-1], f["width_m"]
        soffit, tread = lambda s: f["bottom_z"] + (f["top_z"] - f["bottom_z"]) * s / L - under, lambda s: np.array(hz)[np.searchsorted(st, s, "right") - 1]
        s, w = (a.ravel() for a in np.meshgrid(np.arange(fills.PX / 2, L, fills.PX), np.arange(fills.PX / 2, W, fills.PX) - W / 2))
        assert (tread(s) > soffit(s)).all(), "underside above a tread: under_m too large for this flight"
        sz, z = (a.ravel() for a in np.meshgrid(np.arange(fills.PX / 2, L, fills.PX), np.arange(soffit(0), max(hz), fills.PX)))
        k = (z >= soffit(sz)) & (z <= tread(sz))
        sides = np.concatenate([np.c_[b0 + np.outer(sz[k], u) + e * W / 2 * side, z[k]] for e in (-1, 1)])
        rgb = RISER_SHADE * fills.rgb_of(out[0][:1])   # shaded like the risers
        out += [fills.gaussians(v.dtype, np.c_[b0 + np.outer(s, u) + np.outer(w, side), soffit(s)], np.tile(rgb, (len(s), 1)), 2),
                fills.gaussians(v.dtype, sides, np.tile(rgb, (len(sides), 1)), int(abs(side[1]) > abs(side[0])))]
    return np.concatenate(out)


def main():
    cfg, dst = yaml.safe_load(open(sys.argv[1])), Path(sys.argv[2])
    v = read_ply(dst / "main.ply")
    p = ply_xyz(v)
    pts, rgb = (np.concatenate(x) for x in zip(*[sheet(v, p, b) for b in cfg["clean"]["lighter_imagined_floor"]]))
    stairs = {f["name"]: f for f in cfg["game"]["stairs"]}
    g = np.concatenate([fills.gaussians(v.dtype, pts, rgb, 2)] + [steps(v, p, stairs[e["flight"]], e["risers"], e.get("under_m")) for e in cfg["clean"].get("lighter_imagined_steps", [])])
    write_ply(dst / "imagined_floor.ply", g)
    sc = json.loads((dst / "scene.json").read_text())
    sc["imagined_floor"] = "imagined_floor.ply"
    (dst / "scene.json").write_text(json.dumps(sc, indent=1))
    print(f"{dst / 'imagined_floor.ply'}: {len(pts)} floor discs, {len(g) - len(pts)} step discs, colour {rgb[0].round(2)}")


if __name__ == "__main__":
    # self-check: a flight up +x (seen treads at 0 and 0.2 m, top 0.4 m at 1 m), 2 steps in the first gap, 1 to the top
    dt = np.dtype([(k, "f4") for k in ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", *[f"scale_{i}" for i in range(3)], *[f"rot_{i}" for i in range(4)]]])
    xy = np.stack(np.meshgrid(np.arange(0, 1, 0.05), np.arange(-0.5, 0.5, 0.05)), -1).reshape(-1, 2)
    sp = np.r_[np.c_[xy, np.zeros(len(xy))], np.c_[xy, np.full(len(xy), 0.2)]]
    sv = fills.gaussians(dt, sp, np.full((len(sp), 3), 0.6), 2)
    g = steps(sv, sp, {"bottom": [[0, -0.5], [0, 0.5]], "top": [1, 0], "top_z": 0.4, "treads_z": [0, 0.2], "tread_fronts_m": [0, 0.5], "width_m": 1}, [2, 1])
    flat = np.isclose(g["scale_2"], np.log(0.001))
    assert np.allclose(np.unique(g["z"][flat].round(3)), [-0.01, 0.09, 0.19]), np.unique(g["z"][flat].round(3))   # treads 1 cm under each step
    assert np.allclose(np.unique(g["x"][~flat].round(3)), [0.25, 0.5, 1.0]) and 0.39 < g["z"][~flat].max() < 0.4   # risers at the fronts, up to the top
    e = steps(sv, sp, {"bottom": [[0, -0.5], [0, 0.5]], "top": [1, 0], "bottom_z": -0.1, "top_z": 0.4, "treads_z": [0, 0.2], "tread_fronts_m": [0, 0.5], "width_m": 1}, [2, 1], 0.25)[len(g):]
    flat = np.isclose(e["scale_2"], np.log(0.001))   # the same steps first, then the underside and the two side faces
    assert np.allclose(e["z"][flat], 0.5 * e["x"][flat] - 0.35, atol=1e-6) and np.allclose(np.abs(e["y"][~flat]), 0.5)
    assert (e["z"][~flat] <= np.where(e["x"][~flat] < 0.25, 0, np.where(e["x"][~flat] < 0.5, 0.1, 0.2)) + 1e-6).all()   # sides stop at the treads
    main()
