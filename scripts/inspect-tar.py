#!/usr/bin/env python3
"""Type-aware inspection of untrusted release tarballs; prints selected JSON only."""

from __future__ import annotations

import argparse
import json
import tarfile
from pathlib import Path, PurePosixPath

MAX_ENTRIES = 20_000
MAX_TOTAL_SIZE = 4 * 1024**3
MAX_METADATA_SIZE = 2 * 1024**2


def safe_name(name: str) -> str:
    if "\\" in name or "\x00" in name or name.startswith("/"):
        raise ValueError("archive contains an unsafe path")
    normalized = name.rstrip("/")
    parts = PurePosixPath(normalized).parts
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise ValueError("archive contains path traversal")
    return "/".join(parts)


def read_member(archive: tarfile.TarFile, member: tarfile.TarInfo) -> bytes:
    if not member.isfile() or member.size > MAX_METADATA_SIZE:
        raise ValueError("metadata entry is not a small regular file")
    source = archive.extractfile(member)
    if source is None:
        raise ValueError("metadata entry has no content")
    with source:
        return source.read(MAX_METADATA_SIZE + 1)


def inspect(mode: str, archive_path: Path) -> object:
    seen: set[str] = set()
    seen_folded: set[str] = set()
    total = 0
    selected: tarfile.TarInfo | None = None
    release_marker: tarfile.TarInfo | None = None
    with tarfile.open(archive_path, mode="r:gz") as archive:
        members = archive.getmembers()
        if not members or len(members) > MAX_ENTRIES:
            raise ValueError("archive entry count is invalid")
        for member in members:
            name = safe_name(member.name)
            folded = name.casefold()
            if name in seen or folded in seen_folded:
                raise ValueError("archive has duplicate or case-colliding paths")
            seen.add(name)
            seen_folded.add(folded)
            if not (member.isdir() or member.isfile()):
                raise ValueError("archive contains a link, device, or special file")
            total += member.size
            if total > MAX_TOTAL_SIZE:
                raise ValueError("archive expands beyond the size limit")
            if mode == "npm":
                if not (name == "package" or name.startswith("package/")):
                    raise ValueError("npm archive has an unexpected root")
                if name == "package/package.json":
                    if selected is not None:
                        raise ValueError("npm archive has duplicate metadata")
                    selected = member
            else:
                allowed = (
                    name in (".vercel", ".vercel/output", ".vercel/output/config.json", ".vercel/output/static")
                    or name.startswith(".vercel/output/static/")
                )
                if not allowed:
                    raise ValueError("web archive contains executable or unexpected output")
                if name.endswith(".map") or "/.env" in name:
                    raise ValueError("web archive contains a source map or environment file")
                if name == ".vercel/output/config.json":
                    if selected is not None:
                        raise ValueError("web archive has duplicate config")
                    selected = member
                if name == ".vercel/output/static/__dascode/release.json":
                    release_marker = member
        if selected is None:
            raise ValueError("archive is missing required metadata")
        if mode == "web" and ".vercel/output/static/__dascode/release.json" not in seen:
            raise ValueError("web archive is missing the release identity marker")
        metadata = json.loads(read_member(archive, selected))
        if mode == "web":
            if release_marker is None:
                raise ValueError("web archive is missing the release identity marker")
            return {"config": metadata, "release": json.loads(read_member(archive, release_marker))}
        return metadata


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("npm", "web"))
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    print(json.dumps(inspect(args.mode, args.archive), separators=(",", ":")))


if __name__ == "__main__":
    main()
