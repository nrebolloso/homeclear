import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from zipfile import ZipFile
from import_scans import import_bundle


class ScanImportTests(unittest.TestCase):
    def test_preserves_export_and_does_not_overwrite(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "scans"
            destination.mkdir()
            archive = root / "bedroom_v1.0.0.zip"
            definition = json.dumps({"grid": {"shape": [1, 1]}, "splat": "main.ply"}).encode()
            with ZipFile(archive, "w") as bundle:
                bundle.writestr("room/scene.json", definition)
                bundle.writestr("room/main.ply", b"original scan bytes")
            self.assertIn("Imported", import_bundle(archive, destination))
            target = destination / archive.stem
            self.assertEqual((target / "scene.json").read_bytes(), definition)
            self.assertEqual((target / "main.ply").read_bytes(), b"original scan bytes")
            self.assertIn("Already present", import_bundle(archive, destination))

    def test_rejects_traversal_before_publishing_scene(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "scans"
            destination.mkdir()
            archive = root / "unsafe.zip"
            with ZipFile(archive, "w") as bundle:
                bundle.writestr("room/scene.json", '{"grid": {"shape": [1, 1]}, "splat": "main.ply"}')
                bundle.writestr("room/../escape.txt", "must stay inside the archive")
            with self.assertRaises(ValueError):
                import_bundle(archive, destination)
            self.assertFalse((root / "escape.txt").exists())
            self.assertFalse((destination / "unsafe" / "scene.json").exists())


if __name__ == "__main__":
    unittest.main()
