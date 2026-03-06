#!/usr/bin/env python3
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

KNOWN_HOSTS = [
    "irc.twitch.tv",
    "127.000.000.1",
]


def host_to_bytes(host: str) -> bytes:
    return host.encode("utf-16le")


def find_single_occurrence(data: bytes, hosts: list[str]) -> tuple[int, str]:
    hits: list[tuple[int, str]] = []
    for host in hosts:
        needle = host_to_bytes(host)
        start = 0
        while True:
            idx = data.find(needle, start)
            if idx < 0:
                break
            hits.append((idx, host))
            start = idx + 1
    unique_offsets = {}
    for offset, host in hits:
        unique_offsets.setdefault(offset, host)
    if len(unique_offsets) != 1:
        raise RuntimeError(
            f"Expected exactly one known host occurrence, found {len(unique_offsets)} at offsets {sorted(unique_offsets.keys())}"
        )
    offset = next(iter(unique_offsets))
    return offset, unique_offsets[offset]


def validate_target_host(target: str) -> None:
    if len(target) != 13:
        raise ValueError(
            f"Target host must be exactly 13 characters for safe in-place patching. Got {len(target)}: {target!r}"
        )
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-")
    if any(ch not in allowed for ch in target):
        raise ValueError("Target host contains unsupported characters")


def patch_file(dll_path: Path, target_host: str, make_backup: bool) -> None:
    validate_target_host(target_host)
    if not dll_path.is_file():
        raise FileNotFoundError(f"DLL file not found: {dll_path}")

    data = dll_path.read_bytes()
    offset, current_host = find_single_occurrence(data, KNOWN_HOSTS + [target_host])

    if current_host == target_host:
        print(f"No change needed. DLL already points to {target_host}")
        return

    if make_backup:
        backup_path = dll_path.with_suffix(dll_path.suffix + ".bak")
        if not backup_path.exists():
            shutil.copy2(dll_path, backup_path)
            print(f"Created backup: {backup_path}")
        else:
            print(f"Backup already exists: {backup_path}")

    current_bytes = host_to_bytes(current_host)
    target_bytes = host_to_bytes(target_host)
    patched = bytearray(data)
    patched[offset : offset + len(current_bytes)] = target_bytes

    verify = bytes(patched[offset : offset + len(target_bytes)])
    if verify != target_bytes:
        raise RuntimeError("Verification failed after patch write")

    dll_path.write_bytes(bytes(patched))
    print(f"Patched {dll_path.name}: {current_host} -> {target_host} at offset {offset}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Patch Immortal Redneck Assembly-CSharp.dll Twitch IRC host in-place."
    )
    parser.add_argument(
        "--dll",
        type=Path,
        default=Path(
            "ImmortalRedneck_Data/Managed/Assembly-CSharp.dll"
        ),
        help="Path to Assembly-CSharp.dll",
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.000.000.1",
        help="Target IRC host (must be exactly 13 chars). Default: 127.000.000.1",
    )
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="Do not create .bak backup file",
    )
    args = parser.parse_args()

    try:
        patch_file(args.dll, args.host, make_backup=not args.no_backup)
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"Patch failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
