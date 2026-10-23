"""Rollout figures: ghost walkers, footfall heatmap, hazard hits, toe contacts per month."""
import csv
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from .models import walker_legs


def draw_map(ax, m):
    img = np.full(m.floor.shape + (3,), 0.25)
    img[m.floor] = 1.0
    img[m.bumps] = (1.0, 0.75, 0.4)
    img[m.obstacles] = 0.45
    x0, y0 = m.origin
    H, W = m.floor.shape
    ax.imshow(img.transpose(1, 0, 2), origin="lower", extent=(x0, x0 + H * m.cell, y0, y0 + W * m.cell))
    for o in m.labels:
        if o["kind"] == "bump" or not o["name"].startswith(("wall", "hall", "door")):
            (a, b), (c, d) = o["box_xy"]
            ax.text((a + c) / 2, (b + d) / 2, o["name"], fontsize=6, ha="center", va="center", color="k")
    ax.set_aspect("equal")
    ax.set_xlabel("x (m)")
    ax.set_ylabel("y (m)")


def rollout_figure(m, route, out_dir, summ, walker=None, n_ghosts=24):
    out_dir = Path(out_dir)
    z = np.load(out_dir / "rollout.npz")
    S, Wk = z["steps"], z["walker"]
    from .rollout import load_cfg
    walker = walker or load_cfg()["walker"]
    fig, axs = plt.subplots(2, 2, figsize=(13, 11))
    ax = axs[0, 0]
    draw_map(ax, m)
    trips = np.unique(S[:, :2], axis=0)[:n_ghosts]
    for n, t in trips:
        sel = (S[:, 0] == n) & (S[:, 1] == t)
        ws = (Wk[:, 0] == n) & (Wk[:, 1] == t)
        ax.plot(Wk[ws, 3], Wk[ws, 4], "-", color="tab:purple", lw=0.6, alpha=0.5)
        for side, c in ((1, "tab:blue"), (-1, "tab:red")):
            q = sel & (S[:, 3] == side)
            ax.plot(S[q, 4], S[q, 5], ".", color=c, ms=2, alpha=0.6)
    for pose in Wk[(Wk[:, 0] == trips[0][0]) & (Wk[:, 1] == trips[0][1])][::4, 3:]:
        L = walker_legs(pose, walker)
        ax.plot(*L[[2, 0, 1, 3]].T, "-", color="k", lw=0.7)
    ax.plot(*route.T, "--", color="green", lw=1)
    ax.set_title(f"{len(trips)} ghost walkers ({summ['model']}): heels L blue / R red, walker centre purple, "
                 f"frame every 4th step (black)", fontsize=8)

    ax = axs[0, 1]
    draw_map(ax, m)
    x0, y0 = m.origin
    H, W = m.floor.shape
    h, xe, ye = np.histogram2d(S[:, 4], S[:, 5], bins=[int(H * m.cell / 0.04), int(W * m.cell / 0.04)],
                               range=[[x0, x0 + H * m.cell], [y0, y0 + W * m.cell]])
    h = np.ma.masked_equal(h, 0)
    im = ax.imshow(h.T, origin="lower", extent=(xe[0], xe[-1], ye[0], ye[-1]), cmap="magma_r", alpha=0.85)
    fig.colorbar(im, ax=ax, shrink=0.7, label=f"heel strikes per 4 cm cell ({summ['trips']} trips)")
    ev = list(csv.DictReader(open(out_dir / "events.csv")))
    tc = [e for e in ev if e["type"] == "toe_contact" and e["sampled"] == "1"]
    ax.plot([float(e["x"]) for e in tc], [float(e["y"]) for e in tc], "x", color="red", ms=5, label="sampled toe contact")
    for typ, mk, c in (("snag", "^", "blue"), ("collision", "s", "k")):
        sn = [e for e in ev if e["type"] == typ]
        ax.plot([float(e["x"]) for e in sn], [float(e["y"]) for e in sn], mk, color=c, ms=3, label=f"walker {typ}")
    ax.legend(fontsize=7, loc="upper right")
    ax.set_title("footfall heatmap + events", fontsize=9)

    ax = axs[1, 0]
    hz = {k: v for k, v in summ["per_hazard_per_month"].items()}
    names = sorted(hz, key=lambda k: -(hz[k]["toe_contacts_expected"] + hz[k]["snags"] + hz[k]["brushes"] + hz[k]["collisions"]))
    y = np.arange(len(names))
    ax.barh(y - 0.27, [hz[k]["toe_contacts_expected"] for k in names], 0.27, label="toe contacts (expected)", color="tab:red")
    ax.barh(y, [hz[k]["snags"] for k in names], 0.27, label="walker snags", color="tab:blue")
    ax.barh(y + 0.27, [hz[k]["brushes"] for k in names], 0.27, label="frame brushes", color="tab:gray")
    ax.barh(y + 0.27, [hz[k]["collisions"] for k in names], 0.27, label="leg collisions", color="k", left=[hz[k]["brushes"] for k in names])
    ax.set_yticks(y, names, fontsize=7)
    ax.invert_yaxis()
    ax.set_xscale("symlog", linthresh=0.1)
    ax.set_xlabel("events per month")
    ax.legend(fontsize=7)
    ax.set_title("hazard hits per month (contact table = PLACEHOLDER, not calibrated)", fontsize=9)

    ax = axs[1, 1]
    sr = summ["toe_contacts_by_month"]
    ax.bar(np.arange(1, len(sr) + 1), sr, color="tab:red", label="sampled toe contacts")
    ax.axhline(summ["totals_per_month"]["toe_contacts_expected"], color="k", ls="--", label="expected per month")
    ax.set_xlabel("simulated month (30 nights)")
    ax.set_ylabel("toe contacts")
    ax.legend(fontsize=7)
    ax.set_title(f"toe contacts per month, {summ['nights']} nights x {summ['trips'] // summ['nights']} trips", fontsize=9)
    src = summ["map_source"]
    fig.suptitle(f"Ghost walkers: {Path(summ['map']).name} [{'SYNTHETIC' if 'SYNTHETIC' in src else 'REAL'} map], "
                 f"model = {summ['model']}", fontsize=11)
    fig.tight_layout()
    fig.savefig(out_dir / "rollout.png", dpi=110)
    plt.close(fig)
