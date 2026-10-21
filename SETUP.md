# Chief setup details

The short path is in [README.md](README.md). Start there. This page has the command-line steps, troubleshooting, and the FAQ.

**Try it in 30 seconds.** Open https://lugovelb.github.io/chief-glasses-open/ and type:

```text
orbit maple cinder velvet quartz lantern
```

Nothing to install. That passphrase (a secret phrase) is public and only opens the sample.

Chief is not affiliated with Meta.

## Checklist

- [ ] 1. Open the live demo and type the demo passphrase.
- [ ] 2. Click **Use this template** (or **Fork** if that button is not there yet). Choose **Public**.
- [ ] 3. Edit `config.js` with the pencil. Skip the `YOUR_` lines until you want Send.
- [ ] 4. Turn on Pages: **Settings**, **Pages**, **Deploy from a branch**, branch **main**, folder **/ (root)**.
- [ ] 5. Open your site and type the demo passphrase. A red "not set up" line on Send is expected.

The template button is enabled at go-live under **Settings**, **General**, **Template repository**. You do not need to flip that yourself.

## Settings file

In `config.js`, change only the words inside the quotes, then commit to `main`.

| Line | What it does |
| --- | --- |
| 9 `web3formsKey` | Email through [Web3Forms](https://web3forms.com). |
| 14 `formsubmitId` | Backup email through [FormSubmit](https://formsubmit.co). Paste their random id, not your email address. Leave the placeholder to skip. |
| 19 `ntfyTopic` | Live updates through [ntfy.sh](https://ntfy.sh), not email. Use a long random name. |
| 22 `ntfyServer` | Leave `https://ntfy.sh`. |
| 25 `feedUrl` | Leave `./feed.json` so GitHub Pages loads the message file next to the page. |
| 30 `apiFeedUrl` | Leave `""`. |
| 34 `timeZone` | Leave `""` to use the browser's time zone. |
| 37 `assistantName` | Leave `"Chief"` or change the reply label. |

Send needs one of line 9, line 14, or line 19. Lines 9 and 14 are email. Line 19 is ntfy.

## Send a message without git

1. On your copy, click **Code**, then **Download ZIP**, and unzip it.
2. Double-click `send-message.bat` (Windows) or `send-message.sh` (Mac or Linux). This needs Python from [python.org](https://www.python.org/downloads/). Type the passphrase (hidden), then the message. The first time, while the file is still the sample, type `START OVER`. A backup is saved, then the sample is replaced.
3. On GitHub, **Add file**, **Upload files**, and commit the new `feed.json` only. Do not upload `.venv`.

If `send-message.sh` opens as text: in Terminal, `cd` into the unzipped folder (you are then in the project folder) and run `./send-message.sh`.

## Advanced: command line

Use this only if you want git on your computer. Do these in order.

### Install Git

- Windows: install from https://git-scm.com/download/win
- Mac: open Terminal and run `xcode-select --install`
- Linux: if `git` is missing, install the `git` package from your system.

### Install Python

Install from https://www.python.org/downloads/ if you need it. On Windows, tick **Add python.exe to PATH**.

### Clone, then try the demo on this computer

Replace the names, then run the clone. The `cd` line puts you in the project folder. Every command after that belongs in that folder.

**Windows (PowerShell)**

```powershell
git clone https://github.com/YOUR_NAME/YOUR_REPO.git
cd YOUR_REPO
py -3 -m http.server 8000
```

**Mac or Linux**

```bash
git clone https://github.com/YOUR_NAME/YOUR_REPO.git
cd YOUR_REPO
python3 -m http.server 8000
```

Open http://127.0.0.1:8000 and type the demo passphrase. That address is only for your computer. Do not give it to the glasses.

### Publish with a virtual environment

Still in the project folder from the `cd` above. This replaces `--user` installs. The `.venv` folder stays on your computer.

**Windows (PowerShell)**

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:CHIEF_PASSPHRASE = "word1 word2 word3 word4 word5 word6"
python publish.py --new "Hello. This is your first reply."
git add feed.json
git commit -m "Update the message feed"
git push
```

If Windows will not run the activate script, run this once in that same window, then run the activate line again:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

**Mac or Linux**

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
export CHIEF_PASSPHRASE='word1 word2 word3 word4 word5 word6'
python publish.py --new "Hello. This is your first reply."
git add feed.json
git commit -m "Update the message feed"
git push
```

`--new` removes the sample after saving `feed.backup-<timestamp>.json`. Later replies use the same publish command **without** `--new`, then commit and push `feed.json` again. Set `CHIEF_PASSPHRASE` with the `export` line above first. `publish.py` reads that and does not print it. Do not commit the passphrase.

The file keeps the newest 20 messages.

## On the glasses

Meta's developer preview changes. Follow the linked sections, not a copied menu path. Skip any section about AI coding tools.

- Developer Mode: https://wearables.developer.meta.com/docs/develop/webapps/setup/#enabling-developer-mode-in-the-meta-ai-app
- Add the app by URL: https://wearables.developer.meta.com/docs/develop/webapps/test/#load-the-web-app-on-your-glasses

Use your `https://` Pages address and the passphrase you publish with.

## Security

- Six or more random words. The scrambled file is public.
- The demo passphrase is public. Do not reuse it.
- Messages are scrambled with AES-256-GCM. The passphrase is stretched with PBKDF2-SHA256 for 310,000 iterations.
- The passphrase is stored in the browser's local storage on that device so the next visit can open the chat. **Forget** clears that copy. It does not delete `feed.json`.
- Old copies of the scrambled file can remain in GitHub history. Start with a strong passphrase.
- Lines 9, 14, and 19 are not the passphrase.

## Troubleshooting

**Wrong passphrase.** The page says "Could not decrypt. Wrong passphrase?" Match the capital letters. Do not type quote marks. After a new feed, the demo passphrase will not work.

**Blank screen.** A missing quote in `config.js` can stop the page. Put the quotes back, commit, then reload. Hold Shift and click Reload. On the glasses, close Chief and open it again. If it still looks old, use the reload steps in Meta's docs linked above.

**Pages is not live yet.** A 404 usually means Pages is still finishing, or the source is not **Deploy from a branch** / `main` / **/ (root)**. Give it five minutes after the first save.

**The feed is not updating.** `feed.json` was changed on your computer and not uploaded or pushed. Upload that file, or commit and push it. Wait a minute and tap **Refresh**. The passphrase must be the one that scrambled this file.

**Send says it is not set up.** That red message is expected on the demo. Line 9 and line 14 are still placeholders, and so is line 19, so there is nowhere to deliver a message. Fill in line 9 or line 14 for email, or line 19 for ntfy, then commit. Reading does not need those lines.

**Python was not found.** Install it from https://www.python.org/downloads/ and open a new window. On Windows, tick **Add python.exe to PATH**.

**Git was not found.** Windows: https://git-scm.com/download/win . Mac: `xcode-select --install`.

## FAQ

**Is the message file private?** No. `feed.json` is public. The passphrase is what keeps the text unreadable.

**Do I need Web3Forms to try the demo?** No. You need line 9 or 14 when you want email from the glasses, or line 19 for ntfy. The red "not set up" message until then is normal.

**Can I use this without the glasses?** Yes. Any modern browser can open the page.

**What if I lose the passphrase?** Old messages cannot be read. Run `publish.py --new` with a new passphrase. That saves `feed.backup-<timestamp>.json` first, then starts a new file. Older scrambled copies can still exist in GitHub history.

**Why does Forget ask twice?** So one stray tap does not sign you out. Cancel is the safe choice. Forget clears the passphrase from the browser's local storage on that device.

**How do I hide Yes / No / Later / Tell me more?** Add `?replies=0` to the address.

**Is this an official Meta app?** No. Chief is not affiliated with Meta. It is your own web page. The glasses can show it in Meta's developer preview.

**How are the messages locked?** AES-256-GCM, with the passphrase stretched by PBKDF2-SHA256 for 310,000 iterations.
