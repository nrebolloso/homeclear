"""gsplat 1.6.0 (git 512d366b) 2DGS backward hands non-contiguous grads to a CUDA op that requires contiguous ones:
'RuntimeError: grad.depths must be contiguous' on the first loss.backward(). Make them contiguous. Idempotent.
  python slurm/patch_gsplat_2dgs.py      (inside the pipeline env)"""
import gsplat.cuda._wrapper as w
p = w.__file__
s = open(p).read()
old = "            v_means2d,\n            v_depths,\n            v_ray_transforms,\n            v_normals,\n            ctx.needs_input_grad["
new = "            v_means2d.contiguous(),\n            v_depths.contiguous(),\n            v_ray_transforms.contiguous(),\n            v_normals.contiguous(),\n            ctx.needs_input_grad["
if new in s:
    print("already patched", p)
else:
    assert s.count(old) == 2, f"expected the 2DGS fused + packed backward calls in {p}; gsplat changed, re-check the bug"
    open(p, "w").write(s.replace(old, new))
    print("patched 2 call sites in", p)
