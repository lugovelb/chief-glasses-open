#!/usr/bin/env python3
"""Encrypt one message and append it to feed.json.

The passphrase is the secret phrase you type. This program never prints it.
Set CHIEF_PASSPHRASE yourself only when you run the command by hand.

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
import getpass
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
# Exit 2 is only "this passphrase does not open the feed". Every other failure is 1.
WRONG_PASSPHRASE = 2
# The shipped sample. A real feed must not match all of these at once.
DEMO_MARKER = "chief-sample"
DEMO_IDS = ["gcgdoxx9u37y", "XgGi2P8I0Yxk", "u6miGUbq6GDF"]
DEMO_SALT = "HnK3mYxW621XsCRWaInK/Q=="
DEMO_CTS = frozenset(
    {
        "+Fu8too+NFNrbavIaHEQvK90KFYZkO4TDjJg7S4zckByHP7ykcfOEl++F5jN11uMCqEJmfW0vqPchfiK15lHV5zQnlFIxTdgleekDQVXLDU8ibMMS0M6IKbEtkFMZHmhePD8wiyki0GeDDLY6S1rMRBjAbRTzfJaAHI=",
        "lXup+WezsWvY367KOlOKgWnk93GgTFbmgkIbjnPLXAd19a5Y16XDihqxtEb3HYAOISVY0l9rpo4q0+HarYigYdHLFAr+xv01+hcsI8kVwuuitu02EJpOWztAoQmU2vwckwrQ8iKeaTC9FYRfGo/tFFM=",
        "kHw3kylpM+bGsNJ35DitznKTjrUExO6mN5AXMGdqJpfR5mMPCRMD2gwC/V7boi/N6DXU9+tDcgXre0+siZA/1N6u119phBYL4XUhVJyzPJpzXYMd5tUwTqTqnsjJXc53PqU7/ZyKzBDmtQl9L1lKkuZCqqS6vfPuyN2TW/08uCAc+dvzsDOhbJD1MUADQSCSfcYZb53Ho+87EbqzXQk=",
    }
)


def b64encode(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def b64decode(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"))


def passphrase_from_env() -> str:
    value = os.environ.get(ENV_NAME)
    if value is None or value == "":
        print(
            "No passphrase was provided. The send-message script asks for it. "
            "If you are typing the command yourself, set CHIEF_PASSPHRASE to your passphrase first.",
            file=sys.stderr,
        )
        sys.exit(1)
    return value


def is_shipped_demo(data: dict | None) -> bool:
    """True only for the untouched sample file that shipped with Chief."""
    if not isinstance(data, dict):
        return False
    if data.get("demo") != DEMO_MARKER or data.get("demoIds") != DEMO_IDS:
        return False
    if data.get("salt") != DEMO_SALT:
        return False
    items = data.get("items")
    if not isinstance(items, list) or len(items) != len(DEMO_CTS):
        return False
    cts = []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("ct"), str):
            return False
        cts.append(item["ct"])
    return set(cts) == DEMO_CTS


def backup_feed(path: Path) -> Path:
    """Copy path to feed.backup-<timestamp>.json before a reset."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = path.with_name(f"{path.stem}.backup-{stamp}{path.suffix}")
    extra = 2
    while dest.exists():
        dest = path.with_name(f"{path.stem}.backup-{stamp}-{extra}{path.suffix}")
        extra += 1
    dest.write_bytes(path.read_bytes())
    return dest


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


def publish(text: str, path: Path, new: bool, role: str, keep: int) -> int:
    passphrase = passphrase_from_env()
    existing = None if new else load_feed(path)

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
            return 1
        if len(salt) != SALT_LEN or iterations < 1:
            print(f"{path} has a salt or iteration count this app cannot use.", file=sys.stderr)
            return 1
        items = list(existing["items"])
        if items:
            key = derive_key(passphrase, salt, iterations)
            try:
                decrypt_item(key, items[-1])
            except Exception:
                print("That passphrase does not open your feed.", file=sys.stderr)
                return WRONG_PASSPHRASE

    if new and path.exists():
        saved = backup_feed(path)
        print(f"Saved a backup as {saved.name}.")

    key = derive_key(passphrase, salt, iterations)
    items.append(encrypt_item(key, text, role))
    items = items[-keep:]
    write_feed(path, build_feed(salt, iterations, items))

    if new or existing is None:
        print(f"Started {path} and saved 1 message. Older messages in that file were removed.")
    else:
        print(f"Saved 1 message to {path} ({len(items)} messages now).")
    return 0


def read_line(prompt: str) -> str:
    print(prompt, end="", file=sys.stderr, flush=True)
    return sys.stdin.readline().rstrip("\r\n")


def read_secret(prompt: str) -> str:
    if sys.stdin.isatty():
        return getpass.getpass(prompt)
    return read_line(prompt)


def interactive(path: Path, role: str, keep: int) -> int:
    secret = read_secret("Passphrase (it will not be shown): ")
    if secret.strip() == "":
        print("Type a passphrase. It was empty.", file=sys.stderr)
        return 1
    message = read_line("Message: ")
    if message.strip() == "":
        print("Type a message. It was empty.", file=sys.stderr)
        return 1
    os.environ[ENV_NAME] = secret
    code = publish(message.strip(), path, False, role, keep)
    if code != WRONG_PASSPHRASE:
        return code
    # A wrong passphrase on a real feed must not offer to delete it.
    # Only the untouched shipped sample can be replaced, and only after START OVER.
    if not is_shipped_demo(load_feed(path)):
        print("Your messages were not changed.", file=sys.stderr)
        return WRONG_PASSPHRASE
    print("This file is still the sample that came with Chief.", file=sys.stderr)
    answer = read_line("Type START OVER to replace the sample. A backup is saved first: ")
    if answer.strip() != "START OVER":
        print("Your messages were not changed.", file=sys.stderr)
        return WRONG_PASSPHRASE
    return publish(message.strip(), path, True, role, keep)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Encrypt a message and append it to feed.json."
    )
    parser.add_argument("message", nargs="?", help="Message text. If omitted, read from stdin.")
    parser.add_argument("--feed", default="feed.json", help="Feed file to update (default: feed.json).")
    parser.add_argument("--role", choices=("chief", "owner"), default="chief", help="Who the message is from.")
    parser.add_argument("--new", action="store_true", help="Start a fresh feed and remove old messages.")
    parser.add_argument("--keep", type=int, default=20, help="How many messages to keep (default: 20).")
    parser.add_argument("--demo-feed", action="store_true", help="Exit 0 when the feed is still the shipped sample.")
    parser.add_argument("--interactive", action="store_true", help="Ask for a passphrase and a message.")
    args = parser.parse_args()

    if args.keep < 1:
        print("--keep must be at least 1.", file=sys.stderr)
        sys.exit(1)

    path = Path(args.feed)
    if args.demo_feed:
        sys.exit(0 if is_shipped_demo(load_feed(path)) else 1)
    if args.interactive:
        sys.exit(interactive(path, args.role, args.keep))

    text = read_message(args)
    sys.exit(publish(text, path, args.new, args.role, args.keep))


if __name__ == "__main__":
    main()
