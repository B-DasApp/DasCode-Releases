#!/usr/bin/env python3
"""Extract a GitHub Actions artifact without accepting links or path traversal."""

from __future__ import annotations

import argparse
import os
import shutil
import stat
import zipfile
from pathlib import Path, PurePosixPath

MAX_ENTRIES = 1_000
MAX_TOTAL_SIZE = 8 * 1024**3


def safe_parts(name: str) -> tuple[str, ...]:
    if "\\" in name or "\x00" in name or name.startswith("/"):
        raise ValueError("zip contains an unsafe path")
    path = PurePosixPath(name)
    if any(part in ("", ".", "..") for part in path.parts):
        raise ValueError("zip contains path traversal")
    return path.parts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    args.destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    seen: set[str] = set()
    seen_folded: set[str] = set()
    total = 0
    with zipfile.ZipFile(args.archive) as archive:
        infos = archive.infolist()
        if not infos or len(infos) > MAX_ENTRIES:
            raise ValueError("zip entry count is invalid")
        for info in infos:
            parts = safe_parts(info.filename.rstrip("/"))
            normalized = "/".join(parts)
            folded = normalized.casefold()
            if normalized in seen or folded in seen_folded:
                raise ValueError("zip has duplicate or case-colliding paths")
            seen.add(normalized)
            seen_folded.add(folded)
            mode = info.external_attr >> 16
            file_type = stat.S_IFMT(mode)
            if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError("zip contains a link or special file")
            total += info.file_size
            if total > MAX_TOTAL_SIZE:
                raise ValueError("zip expands beyond the size limit")
            target = args.destination.joinpath(*parts)
            if info.is_dir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
                continue
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with archive.open(info) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            os.chmod(target, 0o600)


if __name__ == "__main__":
    main()
