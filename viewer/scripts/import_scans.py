"""Import original exported scan bundles without rewriting their measurements or metadata."""
import argparse
import json
from pathlib import Path, PurePosixPath
from zipfile import ZipFile


def import_bundle(archive: Path, destination: Path) -> str:
    destination = destination.resolve()
    target = destination / archive.stem
    if not target.resolve().is_relative_to(destination) or target.resolve() == destination:
        raise ValueError("Destination escapes scan library")
    if target.exists():
        return f"Already present: {target.name}"
    with ZipFile(archive) as bundle:
        definitions = [n for n in bundle.namelist() if PurePosixPath(n).name == "scene.json"]
        if len(definitions) != 1:
            raise ValueError(f"{archive.name}: expected one scene definition")
        prefix = PurePosixPath(definitions[0]).parent
        scene = json.loads(bundle.read(definitions[0]))
        if not scene.get("grid") or not scene.get("splat"):
            raise ValueError(f"{archive.name}: incomplete viewer export")
        staging = target
        staging.mkdir(parents=True)
        # Publish scene.json last: dev servers must never discover a half-extracted room.
        for member in sorted(bundle.infolist(), key=lambda m: PurePosixPath(m.filename).name == "scene.json"):
            name = PurePosixPath(member.filename)
            if member.is_dir() or not name.is_relative_to(prefix):
                continue
            relative = name.relative_to(prefix)
            if name.is_absolute() or ".." in relative.parts or "\\" in member.filename or (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError(f"Unsafe archive member: {member.filename}")
            output = staging.joinpath(*relative.parts).resolve()
            if not output.is_relative_to(staging.resolve()):
                raise ValueError(f"Archive path escapes staging: {member.filename}")
            output.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(member) as source, output.open("wb") as sink:
                while chunk := source.read(1024 * 1024):
                    sink.write(chunk)
        if not target.resolve().is_relative_to(destination) or target.resolve() == destination:
            raise ValueError("Destination escapes scan library")
        return f"Imported: {target.name}"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundles", type=Path, nargs="?", default=Path(__file__).resolve().parents[3] / "scenes_bundle")
    parser.add_argument("--destination", type=Path, default=Path(__file__).resolve().parents[1] / "public" / "scene")
    args = parser.parse_args()
    args.destination.mkdir(parents=True, exist_ok=True)
    for archive in sorted(args.bundles.glob("*.zip")):
        print(import_bundle(archive, args.destination), flush=True)
