from __future__ import annotations

import io
import json
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ArchiveSafetyTests(unittest.TestCase):
    def test_zip_traversal_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "bad.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("../escape", b"bad")
            result = subprocess.run(
                ["python3", str(ROOT / "scripts/safe-extract-zip.py"), str(archive), str(root / "out")],
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "escape").exists())

    def test_web_archive_rejects_functions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "web.tgz"
            with tarfile.open(archive, "w:gz") as output:
                for name, content in (
                    (".vercel/output/config.json", b'{"version":3}'),
                    (".vercel/output/static/__dascode/release.json", b'{"schemaVersion":1}'),
                    (".vercel/output/functions/code.func/index.js", b"bad"),
                ):
                    info = tarfile.TarInfo(name)
                    info.size = len(content)
                    output.addfile(info, io.BytesIO(content))
            result = subprocess.run(
                ["python3", str(ROOT / "scripts/inspect-tar.py"), "web", str(archive)],
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)

    def test_valid_static_web_archive_is_inspected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "web.tgz"
            marker = {"schemaVersion": 1, "channel": "canary", "version": "1.0.0-canary.20260816.1", "sourceSha": "a" * 40}
            with tarfile.open(archive, "w:gz") as output:
                for name, content in (
                    (".vercel/output/config.json", b'{"version":3}'),
                    (".vercel/output/static/__dascode/release.json", json.dumps(marker).encode()),
                    (".vercel/output/static/index.html", b"ok"),
                ):
                    info = tarfile.TarInfo(name)
                    info.size = len(content)
                    output.addfile(info, io.BytesIO(content))
            result = subprocess.run(
                ["python3", str(ROOT / "scripts/inspect-tar.py"), "web", str(archive)],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(json.loads(result.stdout)["release"], marker)

    def test_npm_extractor_rejects_project_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "npm.tgz"
            with tarfile.open(archive, "w:gz") as output:
                for name, content in (
                    ("package/package.json", b'{"name":"@das-org/dascode"}'),
                    ("package/.npmrc", b"registry=https://example.invalid"),
                ):
                    info = tarfile.TarInfo(name)
                    info.size = len(content)
                    output.addfile(info, io.BytesIO(content))
            result = subprocess.run(
                [
                    "python3",
                    str(ROOT / "scripts/safe-extract-npm.py"),
                    str(archive),
                    str(root / "out"),
                ],
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
