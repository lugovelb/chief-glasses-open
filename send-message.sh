#!/usr/bin/env bash
# Double-click or run ./send-message.sh
# Asks for a passphrase (not shown) and a message, then updates feed.json.
# The passphrase is never printed.

set -o pipefail
cd "$(dirname "$0")" || exit 1

finish() {
  if [ -t 0 ]; then
    printf 'Press Enter to close... '
    read -r _
  fi
}
trap finish EXIT

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 was not found."
  echo "Install it from https://www.python.org/downloads/"
  exit 1
fi

if [ ! -x .venv/bin/python ]; then
  echo "First-time setup. This can take a minute."
  if ! python3 -m venv .venv; then
    rm -rf .venv
    echo "Could not create the toolbox folder (.venv)."
    echo "If the message above mentions ensurepip, install the python3-venv package and run this again."
    exit 1
  fi
fi

# Check the toolbox itself, not the system Python. A half-finished setup
# (window closed during the first install) leaves .venv without cryptography.
if ! .venv/bin/python -c "import cryptography.hazmat.primitives.ciphers.aead" >/dev/null 2>&1; then
  echo "Installing what the send script needs into the toolbox folder (.venv)."
  if ! .venv/bin/python -m pip install -r requirements.txt; then
    echo "Could not install it. Check your internet connection, then run this again."
    echo "If it keeps failing, delete the .venv folder and run this again. Your feed.json is not touched."
    exit 1
  fi
fi

# publish.py exits 2 only when the passphrase does not open the feed.
# It offers to replace the file only for that case, and only while feed.json
# is still the shipped sample. A wrong passphrase never deletes a real feed.
.venv/bin/python publish.py --interactive
code=$?

if [ "$code" -eq 0 ]; then
  echo "Next: on GitHub, use Add file, Upload files, and commit the new feed.json to main."
  echo "Upload only feed.json. Do not upload the .venv folder."
fi
exit "$code"
