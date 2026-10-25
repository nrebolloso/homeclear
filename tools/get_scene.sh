#!/bin/bash
# Install a scene bundle (splats, maps, object plys) next to the scene's tracked JSON.
#   tools/get_scene.sh [scene] [zip]        zip: a local file; without it, fetched from the group /blue folder (hpg.sh)
# The bundle name and sha256 come from the tracked viewer/public/scene/<scene>/version.json.
set -euo pipefail
cd "$(dirname "$0")/.."
SCENE=${1:-kitchen4_lighter}
DIR=viewer/public/scene/$SCENE
V=$DIR/version.json
[ -f "$V" ] || { echo "no $V (pull main first)"; exit 1; }
field() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$V" "$1"; }
ZIPNAME=$(field bundle); SHA=$(field sha256)
ZIP=${2:-}
if [ -z "$ZIP" ]; then
  ZIP=${TMPDIR:-/tmp}/$ZIPNAME
  if [ ! -f "$ZIP" ]; then
    # shellcheck disable=SC1091
    source ./hpg.sh && hpg_load configs/kitchen4.yaml
    hpg_rsync -a --progress "$HOST:/blue/dream_team/nrebolloso/scene_bundles/$ZIPNAME" "$ZIP"
  fi
fi
echo "$SHA  $ZIP" | sha256sum -c - || { echo "checksum mismatch: $ZIP is not $ZIPNAME"; exit 1; }
# a symlinked scene dir (worktrees share one) would put the tracked JSON outside git; install into a real folder
[ -L "$DIR" ] && { echo "$DIR is a symlink; replace it with a real folder first"; exit 1; }
# the zip holds no tracked JSON, so it never overwrites what git checked out
unzip -oq "$ZIP" -d viewer/public/scene
echo "installed $(field version) into $DIR"
