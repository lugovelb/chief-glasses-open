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
  .venv/bin/python -m pip install -r requirements.txt || exit 1
fi

printf 'Passphrase (it will not be shown): '
if [ -t 0 ]; then
  read -r -s CHIEF_PASSPHRASE || exit 1
  printf '\n'
else
  IFS= read -r CHIEF_PASSPHRASE || exit 1
fi
export CHIEF_PASSPHRASE
if [ -z "$CHIEF_PASSPHRASE" ]; then
  echo "Passphrase was empty."
  unset CHIEF_PASSPHRASE
  exit 1
fi

printf 'Message: '
IFS= read -r MSG || exit 1
if [ -z "$MSG" ]; then
  echo "Message was empty."
  unset CHIEF_PASSPHRASE
  exit 1
fi

.venv/bin/python publish.py "$MSG"
code=$?
if [ "$code" -ne 0 ]; then
  echo "The sample feed uses a different passphrase."
  printf 'Type yes to start a new feed and remove the sample: '
  IFS= read -r AGAIN || AGAIN=""
  if [ "$AGAIN" = "yes" ]; then
    .venv/bin/python publish.py --new "$MSG"
    code=$?
  fi
fi

unset CHIEF_PASSPHRASE
if [ "$code" -eq 0 ]; then
  echo "Next: on GitHub, use Add file, Upload files, and commit the new feed.json to main."
  echo "Upload only feed.json. Do not upload the .venv folder."
fi
exit "$code"
