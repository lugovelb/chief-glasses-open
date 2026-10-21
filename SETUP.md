# Chief setup (short version)

The full guide, with pictures and fixes, is in [README.md](README.md). This is the same path, shortened.

The sample passphrase is public. It only opens the sample messages:

```text
orbit maple cinder velvet quartz lantern
```

## 1. Copy the project

Sign in to GitHub, open this project, and click **Fork**. **Use this template** is fine too. If the repository is already yours, skip this.

## 2. Edit `config.js`

On GitHub, open `config.js`, click the pencil, and change only the words inside the quotes. Then click **Commit changes** (to `main`).

| Line | Replace | With |
| --- | --- | --- |
| 9 | `YOUR_WEB3FORMS_KEY` | Your key from https://web3forms.com |
| 14 | `YOUR_FORMSUBMIT_ID` | The random id FormSubmit emails you, or leave this line alone |
| 19 | `YOUR_NTFY_TOPIC` | A long random name you invent (letters, numbers, dashes) |

Leave line 22 as `https://ntfy.sh`, line 25 as `feed.json`, line 30 as `""`, line 34 as `""` (the browser's time zone), and line 37 as `"Chief"` unless you have a reason to change them.

Do not paste your email address into this file. The demo works before you fill in the `YOUR_...` lines. Sending from the glasses needs at least line 9 or line 19.

## 3. Turn on Pages

**Settings** → **Pages** → **Deploy from a branch** → branch **main**, folder **/ (root)** → **Save**.

Wait until GitHub shows a live address like `https://YOUR_NAME.github.io/YOUR_REPO/`. Copy it. The glasses need the `https://` address.

## 4. Try the demo

Open that address in a normal browser. Type the sample passphrase above. You should see a sample reply and the buttons **Yes**, **No**, **Later**, and **Tell me more**.

On your own computer, from the project folder, you can instead run `python3 -m http.server 8000` and open `http://127.0.0.1:8000`. Do not give that address to the glasses.

## 5. Publish your own first message

Install Python from https://www.python.org/downloads/ if you need it (on Windows, check **Add python.exe to PATH**). Choose six or more random words. Do not reuse the sample passphrase.

**Windows (PowerShell)**, in a new terminal:

```powershell
git clone https://github.com/YOUR_NAME/YOUR_REPO.git
cd YOUR_REPO
py -3 -m pip install -r requirements.txt
$env:CHIEF_PASSPHRASE = "word1 word2 word3 word4 word5 word6"
py -3 publish.py --new "Hello. This is your first reply."
git add feed.json
git commit -m "Update the message feed"
git push
```

**Mac or Linux:**

```bash
git clone https://github.com/YOUR_NAME/YOUR_REPO.git
cd YOUR_REPO
python3 -m pip install -r requirements.txt
export CHIEF_PASSPHRASE='word1 word2 word3 word4 word5 word6'
python3 publish.py --new "Hello. This is your first reply."
git add feed.json
git commit -m "Update the message feed"
git push
```

`--new` removes the sample. The script does not print the passphrase. Later messages use the same command without `--new`, then commit and push `feed.json` again.

Reload the site and unlock with your words.

## 6. Add it to the glasses

Meta's developer preview changes. Follow Meta's current pages, not a copied menu path:

- Setup and Developer Mode: https://wearables.developer.meta.com/docs/develop/webapps/setup/
- Add the app by URL: https://wearables.developer.meta.com/docs/develop/webapps/test/

Use the `https://` address from step 3, then enter the passphrase from step 5.

## If something breaks

- Wrong passphrase: match the capital letters, and do not type quotes. After `--new`, the sample passphrase will not work.
- Blank page: check for a missing quote in `config.js`, commit, then reload.
- 404: Pages is not finished, or the branch/folder is not `main` and `/ (root)`.
- New reply missing: push `feed.json`, wait a minute, tap **Refresh**.
