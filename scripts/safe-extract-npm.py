#!/usr/bin/env python3
"""Safely extract a validated npm archive before credentialed npm parses it."""

from __future__ import annotations

import argparse
import os
import shutil
import tarfile
from pathlib import Path, PurePosixPath

MAX_ENTRIES = 20_000
MAX_TOTAL_SIZE = 4 * 1024**3


def safe_parts(name: str) -> tuple[str, ...]:
    if "\\" in name or "\x00" in name or name.startswith("/"):
        raise ValueError("npm tar contains an unsafe path")
    parts = PurePosixPath(name.rstrip("/")).parts
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise ValueError("npm tar contains path traversal")
    if parts[0] != "package":
        raise ValueError("npm tar has an unexpected root")
    if any(part == ".npmrc" for part in parts):
        raise ValueError("npm tar contains a forbidden npm configuration file")
    return parts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    args.destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    seen: set[str] = set()
    seen_folded: set[str] = set()
    total = 0
    with tarfile.open(args.archive, mode="r:gz") as archive:
        members = archive.getmembers()
        if not members or len(members) > MAX_ENTRIES:
            raise ValueError("npm tar entry count is invalid")
        for member in members:
            parts = safe_parts(member.name)
            normalized = "/".join(parts)
            folded = normalized.casefold()
            if normalized in seen or folded in seen_folded:
                raise ValueError("npm tar has duplicate or case-colliding paths")
            seen.add(normalized)
            seen_folded.add(folded)
            if not (member.isdir() or member.isfile()):
                raise ValueError("npm tar contains a link or special file")
            total += member.size
            if total > MAX_TOTAL_SIZE:
                raise ValueError("npm tar expands beyond the size limit")
            target = args.destination.joinpath(*parts)
            if member.isdir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
                continue
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise ValueError("npm tar regular file has no content")
            with source, target.open("xb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
            os.chmod(target, 0o755 if member.mode & 0o111 else 0o600)
    if "package/package.json" not in seen:
        raise ValueError("npm tar is missing package/package.json")


if __name__ == "__main__":
    main()
