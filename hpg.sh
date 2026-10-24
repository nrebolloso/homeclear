# Sourced by the laptop-side scripts (run_all.sh, cosmos/submit_cosmos.sh, cosmos/fetch_cosmos.sh, cosmos/prerender.py's
# shell-outs): the venv python, the cluster settings (config + cluster.local.yaml) and ssh/rsync over the ControlMaster.
#   hpg_load <config.yaml>   sets HOST REPO ENV HPG_ROOT and SSH, RSYNC
# On Windows (Git Bash) ssh and rsync run inside WSL, where the ControlMaster lives: Windows OpenSSH has no ControlMaster.
# Open it once (password + Duo), in Linux or in WSL:
#   ssh -o ControlMaster=yes -o ControlPath=~/.ssh/cm-hpg -o ControlPersist=12h -o ServerAliveInterval=30 -o ServerAliveCountMax=6 <user>@hpg.rc.ufl.edu
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) PY=.venv/Scripts/python; X="wsl -e" ;;
  *) PY=.venv/bin/python; X= ;;
esac
# %d = the home directory of whoever runs ssh (the WSL user on Windows): no ~ for Git Bash to expand the wrong way
SSH_OPTS="-o ControlPath=%d/.ssh/cm-hpg -o BatchMode=yes"
hpg_load() {
  eval "$($PY -c "import sys; sys.path.insert(0, '.'); from common import cluster_shell; print(cluster_shell(sys.argv[1]))" "$1")"
  export HPG_ROOT
  SSH="$X ssh $SSH_OPTS"
  RSYNC="$X rsync"
}
hpg_ssh() { $X ssh $SSH_OPTS "$HOST" "$@"; }
hpg_rsync() { $X rsync -e "ssh $SSH_OPTS" "$@"; }
