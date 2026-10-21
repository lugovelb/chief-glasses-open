#!/usr/bin/env python3
"""Encrypt one message and append it to feed.json.

The passphrase comes from the environment variable CHIEF_PASSPHRASE.
This program never prints that value.

Setup (once), from this folder:

    python3 -m pip install -r requirements.txt
    export CHIEF_PASSPHRASE='six or more random words'
    python3 publish.py --new "Your first reply"

After the first message, add another with:

    python3 publish.py "The next reply"
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ITERATIONS = 310_000
SALT_LEN = 16
IV_LEN = 12
ENV_NAME = "CHIEF_PASSPHRASE"


def b64encode(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def b64decode(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"))


def passphrase_from_env() -> str:
    value = os.environ.get(ENV_NAME)
    if value is None or value == "":
        print(
            f"{ENV_NAME} is not set. Set it in the environment and run this again.",
            file=sys.stderr,
        )
        sys.exit(1)
    return value


def new_id() -> str:
    token = b64encode(os.urandom(9))
    return token.replace("+", "x").replace("/", "x").replace("=", "x")


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def derive_key(passphrase: str, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac(
        "sha256", passphrase.encode("utf-8"), salt, iterations, dklen=32
    )


def encrypt_item(key: bytes, text: str, role: str) -> dict:
    iv = os.urandom(IV_LEN)
    payload = json.dumps(
        {"t": stamp(), "text": text, "role": role, "id": new_id()},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    ciphertext = AESGCM(key).encrypt(iv, payload, None)
    return {"iv": b64encode(iv), "ct": b64encode(ciphertext)}


def decrypt_item(key: bytes, item: dict) -> dict:
    plain = AESGCM(key).decrypt(b64decode(item["iv"]), b64decode(item["ct"]), None)
    return json.loads(plain.decode("utf-8"))


def load_feed(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Could not read {path}: {exc}", file=sys.stderr)
        sys.exit(1)
    if not isinstance(data, dict) or data.get("v") != 1 or not isinstance(data.get("items"), list):
        print(f"{path} is not a Chief feed.", file=sys.stderr)
        sys.exit(1)
    return data


def write_feed(path: Path, feed: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(feed, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def build_feed(salt: bytes, iterations: int, items: list) -> dict:
    return {"v": 1, "salt": b64encode(salt), "iter": iterations, "items": items}


def read_message(args: argparse.Namespace) -> str:
    if args.message is not None:
        text = args.message
    elif not sys.stdin.isatty():
        text = sys.stdin.read()
    else:
        print("Write the message after the command, or pipe it in.", file=sys.stderr)
        sys.exit(1)
    text = text.strip()
    if not text:
        print("The message is empty.", file=sys.stderr)
        sys.exit(1)
    return text


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Encrypt a message and append it to feed.json."
    )
    parser.add_argument("message", nargs="?", help="Message text. If omitted, read from stdin.")
    parser.add_argument("--feed", default="feed.json", help="Feed file to update (default: feed.json).")
    parser.add_argument("--role", choices=("chief", "owner"), default="chief", help="Who the message is from.")
    parser.add_argument("--new", action="store_true", help="Start a fresh feed and remove old messages.")
    parser.add_argument("--keep", type=int, default=20, help="How many messages to keep (default: 20).")
    args = parser.parse_args()

    if args.keep < 1:
        print("--keep must be at least 1.", file=sys.stderr)
        sys.exit(1)

    text = read_message(args)
    passphrase = passphrase_from_env()
    path = Path(args.feed)
    existing = None if args.new else load_feed(path)

    if existing is None:
        salt = os.urandom(SALT_LEN)
        iterations = ITERATIONS
        items: list = []
    else:
        try:
            salt = b64decode(existing["salt"])
            iterations = int(existing.get("iter") or ITERATIONS)
        except (KeyError, ValueError, TypeError):
            print(f"{path} is missing its salt.", file=sys.stderr)
            sys.exit(1)
        if len(salt) != SALT_LEN or iterations < 1:
            print(f"{path} has a salt or iteration count this app cannot use.", file=sys.stderr)
            sys.exit(1)
        items = list(existing["items"])
        if items:
            key = derive_key(passphrase, salt, iterations)
            try:
                decrypt_item(key, items[-1])
            except Exception:
                print(
                    "That passphrase does not open the existing feed. "
                    "Check the environment variable, or run again with --new "
                    "to start a fresh feed (this removes the current messages).",
                    file=sys.stderr,
                )
                sys.exit(1)

    key = derive_key(passphrase, salt, iterations)
    items.append(encrypt_item(key, text, args.role))
    items = items[-args.keep :]
    write_feed(path, build_feed(salt, iterations, items))

    if args.new or existing is None:
        print(f"Started {path} and saved 1 message. Older messages in that file were removed.")
    else:
        print(f"Saved 1 message to {path} ({len(items)} messages now).")


if __name__ == "__main__":
    main()
