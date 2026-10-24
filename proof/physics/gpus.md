# GPUs on HiPerGator's RTX 6000 partition (checked 2026-10-24)

| | |
|---|---|
| Partition | `hpg-rtx6000` |
| GPU | NVIDIA RTX PRO 6000 (Blackwell), 96 GB each; Slurm GRES `gpu:rtx_pro_6000:8` |
| Node | Lenovo SR675 V3: 8 GPUs, AMD EPYC 9555 (128 cores, 16 per GPU), 1,536 GB RAM, ConnectX-7 InfiniBand |
| Size | 45 nodes (360 GPUs); `sinfo` on 2026-10-24: 43 mixed, 1 drain, 1 maint |
| Node features | `amd, turin, infiniband, gpu, rtx6000, el9` |
| Our allocation | `dream_team` investment QOS: 32 CPU / 250 GB / 4 GPU; burst QOS `dream_team-b` |
| Load | RTX 6000 partition about 88% used (B200 96%) when checked |

Sources: UF RC docs, https://docs.rc.ufl.edu/resources/gpus/ and the GPU access page on docs.rc.ufl.edu; the HiPerGator
hardware spec sheet (Aug 2025); `sinfo` on the login node (a query only; no GPU work there).

## What this meant for the batch study

The batch physics study runs on MuJoCo, which is CPU only and fast to set up (`pip install mujoco`). It needs no GPU,
so it ran as a 32-task CPU array on the burst QOS (`slurm/physics_batch.sbatch`) instead of competing for busy RTX 6000s.
Isaac Sim would need these GPUs plus a container and an Omniverse setup, which would add no accuracy for rigid
bodies this simple. So it wasn't tried.
