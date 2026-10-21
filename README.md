# Chief

Chief is a small web page for Meta Ray-Ban Display glasses. It shows replies from your assistant. The replies are scrambled before they are saved, and the page unscrambles them with a passphrase you type once.

You can also read it in a normal browser. The glasses are optional.

The sample conversation in this repository is fake. It is only there so you can try the page. The passphrase for that sample is public. Do not use it for real messages.

## What it looks like

The unlock screen. Nothing is readable until the passphrase is right.

![Unlock screen with a passphrase box](docs/screenshots/unlock.png)

A reply, with the quick-reply buttons underneath. Those buttons are on unless you add `?replies=0` to the address.

![Message view with a reply and quick-reply buttons](docs/screenshots/messages.png)

Forget asks a second time. Cancel is the highlighted choice. Nothing is erased until you confirm.

![Forget confirmation with Cancel highlighted](docs/screenshots/forget.png)

## Quick start

Do these in order. Each step is one job.

### 1. Make your own copy on GitHub

1. Sign in to GitHub.
2. Open this project.
3. Click **Fork** at the top of the page.
4. If you see **Use this template** instead, that button is fine too.
5. If this repository is already yours, skip the fork and stay here.

You now have your own copy. The rest of these steps happen in that copy.

### 2. Edit `config.js`

You can do this on the GitHub website. You do not need to install anything yet.

1. Open your copy of the repository.
2. Click the file `config.js`.
3. Click the pencil icon (**Edit this file**).
4. Change only the words inside the quotes. Leave the names on the left as they are.
5. When you are done, click **Commit changes**, then confirm. Commit directly to the `main` branch.

The demo in step 4 works even if you leave every `YOUR_...` line alone. Fill in the three `YOUR_...` lines before you expect **Send** on the glasses to reach your inbox.

| Line | Name | What to put |
| --- | --- | --- |
| 9 | `web3formsKey` | Replace `YOUR_WEB3FORMS_KEY` with the access key from [Web3Forms](https://web3forms.com). It is a long id with dashes. On that site, enter the email where you want messages to arrive, create a key, and paste the key here. Keep the quote marks. |
| 14 | `formsubmitId` | Optional backup. [FormSubmit](https://formsubmit.co) emails you a random id after you confirm your address. Paste that id in place of `YOUR_FORMSUBMIT_ID`. Do not paste your email address. If you do not want a backup, leave `YOUR_FORMSUBMIT_ID` as it is. |
| 19 | `ntfyTopic` | Replace `YOUR_NTFY_TOPIC` with a long random name you make up, using letters, numbers, and dashes. Example of the shape only (do not use this one): `chief-7f3a9c2e1b84d056a4e8c917`. Anyone who knows the name can post to it, so make it long. You do not need an account at [ntfy.sh](https://ntfy.sh). |
| 22 | `ntfyServer` | Leave `https://ntfy.sh` unless you run your own ntfy server. |
| 25 | `feedUrl` | Leave `feed.json`. That is the message file next to the page. |
| 30 | `apiFeedUrl` | Leave the quotes empty (`""`). Fill this in later only if new replies are slow to show up. Use your own GitHub names, not the placeholders in the comment above the line. |
| 34 | `timeZone` | Leave the quotes empty (`""`). The page then uses the time zone of the browser or the glasses. To force one zone, put a name such as `"America/Chicago"` inside the quotes. |
| 37 | `assistantName` | Leave `"Chief"`, or change the word that labels incoming replies. |

A finished line looks like this, with your own key and the quotes still there:

```javascript
web3formsKey: "paste-the-key-here",
```

If the page is later blank, you probably deleted a quote. Put the quote back and commit again.

### 3. Turn on GitHub Pages and copy the address

1. In your repository, click **Settings**.
2. Click **Pages** in the left sidebar.
3. Under **Build and deployment**, set the source to **Deploy from a branch**.
4. Set the branch to **main** and the folder to **/ (root)**.
5. Click **Save**.
6. Wait until the page says the site is live. This often takes one to five minutes.
7. Copy the address. It looks like `https://YOUR_NAME.github.io/YOUR_REPO/`.

The glasses need the `https://` address. An `http://` address will not open on the glasses.

### 4. Try the demo in a normal browser

1. Paste the address from step 3 into Chrome, Safari, or Firefox on your computer.
2. When the passphrase box appears, type this exactly. Capital letters matter. One space between words. Do not type the quote marks.

```text
orbit maple cinder velvet quartz lantern
```

3. Click **Unlock**.
4. You should see the sample welcome, a short question, and a sample reply. Under the reply are four buttons: **Yes**, **No**, **Later**, and **Tell me more**.

![The demo after unlock](docs/screenshots/messages.png)

That passphrase is public. It only opens the sample. After step 5 it will stop working, on purpose.

To try the same demo on this computer before Pages is ready, open a terminal in the project folder and run:

```bash
python3 -m http.server 8000
```

Then open `http://127.0.0.1:8000` and use the same passphrase. That address is only for your computer. Do not give it to the glasses.

### 5. Choose your own passphrase and publish your first message

Pick **six or more random words**. Do not use the demo passphrase, a sentence, a lyric, or a pet name. Write the words down somewhere safe that is not this repository. You will type them on the glasses.

This step needs Python on your computer. If you do not have it, install it from [python.org/downloads](https://www.python.org/downloads/). On Windows, check the box that says **Add python.exe to PATH**.

The commands below replace the sample messages. Run them in the project folder (the folder that contains `publish.py`). Replace `YOUR_NAME`, `YOUR_REPO`, and the six words.

**Windows (PowerShell)**

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

**Mac or Linux**

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

If `pip` says it is not allowed to install, run the same install line again with `--user` before `-r`.

`--new` deletes the sample and starts a new scrambled file. The script reads the passphrase from the environment. It does not print it. Do not put the passphrase in the command that publishes the message, and do not commit it.

Git may ask you to sign in to GitHub before `git push` works. After the push, wait about a minute, reload the site, and unlock with **your** words. The demo passphrase will not open this new file.

To add another reply later, run the publish command again **without** `--new`, then commit and push `feed.json` the same way:

```bash
python3 publish.py "Here is the next reply."
```

The file keeps the newest 20 messages.

### 6. Add the page to Meta Ray-Ban Display

This is Meta's developer preview. The taps change. If a blog post disagrees with Meta's own pages, follow Meta.

1. Follow the current setup guide and turn on Developer Mode: [Wearables Web Apps setup](https://wearables.developer.meta.com/docs/develop/webapps/setup/).
2. Add the web app by its URL, using the steps on [Test and load a web app](https://wearables.developer.meta.com/docs/develop/webapps/test/).
3. Use the `https://` address from step 3. Do not use `http://`, and do not use `127.0.0.1`.
4. On the glasses, open Chief and enter the passphrase from step 5.

The first time, the glasses may mark the page as unverified. That is normal for a page you host yourself.

## Signing out

**Forget** does not sign you out on the first tap. It opens a confirmation. **Cancel** is the focused button. Press **Forget** on that second screen to remove the passphrase from this device. The message file on GitHub is not deleted.

![Forget confirmation](docs/screenshots/forget.png)

Closing the page with the glasses' back control leaves the chat in place. The next open can show it again without an extra "are you sure?" step. One back from the main screen is enough to leave.

Quick replies are on by default. To hide them, add `?replies=0` to the end of the address, for example `https://YOUR_NAME.github.io/YOUR_REPO/?replies=0`.

## Security

- Use six or more random words. The scrambled file is public. Anyone can download it and try to guess the passphrase. A short or famous phrase can be guessed. A long random one cannot, in any practical sense.
- The demo passphrase is public. It is printed above on purpose. Do not reuse it.
- Old copies of the scrambled file can stay in GitHub's history even after you replace them. Changing the passphrase later does not hide those old copies. Start with a strong passphrase.
- The Web3Forms key, the FormSubmit id, and the ntfy topic are not the passphrase. They are public on purpose. Someone who knows the Web3Forms key can send mail to your inbox. They still cannot read the feed.
- Do not put your email address in `config.js`.
- The glasses remember the passphrase on the device until you confirm **Forget**.
- A copied old live message is ignored. Chief skips a message id it has already accepted, and it skips a live update whose time is older than the newest one it has already accepted. The saved history in the feed still shows.
- The publisher never prints the passphrase. Keep it out of chat, screenshots, and git.

## Troubleshooting

**Wrong passphrase.** The page says "Could not decrypt. Wrong passphrase?" Type the demo passphrase exactly as it appears in step 4, or type the words you set in step 5. Capital letters matter. Do not include quote marks. After you use `--new`, the demo passphrase stops working. That is expected.

**Blank screen.** Wait a minute and reload. If you just edited `config.js`, a missing quote can stop the page. Open `config.js` and check that every value still has a quote on each side. Then hold Shift and click Reload. On a phone, close the tab and open the address again. On the glasses, close Chief and open it again. If it still looks old, use Meta's current reload steps in the docs linked in step 6.

**Pages is not live yet.** A "404" or "site not found" usually means step 3 is still finishing, or the source is not "Deploy from a branch" / `main` / `/ (root)`. Open **Settings**, then **Pages**, and read the line that says whether the site is live. Give it five minutes after the first save.

**The feed is not updating.** The usual cause is that `publish.py` updated the file on your computer, and that file was not pushed. Run `git add feed.json`, commit, and `git push`. Wait a minute, then tap **Refresh** on the page. The passphrase you type must be the one that scrambled this file. The page shows at most 20 messages.

**Send says it is not set up.** Line 9 in `config.js` still says `YOUR_WEB3FORMS_KEY`, and line 19 still says `YOUR_NTFY_TOPIC`. Fill in at least one, commit, and push. Reading messages does not need those lines. Sending does.

**pip or py is not found.** Install Python from [python.org/downloads](https://www.python.org/downloads/), then open a new terminal and run the install line from step 5 again.

## FAQ

**Is the message file private?** No. `feed.json` is public. The passphrase is what keeps the text unreadable.

**Do I need Web3Forms to try the demo?** No. You need it when you want **Send** on the glasses to email you.

**Can I use this without the glasses?** Yes. Any modern browser can open the page.

**What if I lose the passphrase?** The old messages cannot be read. Run `publish.py --new` with a new passphrase, commit, and push. That starts a new file and removes the old messages from the current file. Older copies can still exist in GitHub history, still scrambled with the passphrase you lost.

**Why does Forget ask twice?** So a stray tap does not sign you out. Cancel is the safe choice.

**How do I hide the Yes / No / Later / Tell me more buttons?** Add `?replies=0` to the address.

**Is this an official Meta app?** No. It is your own web page. The glasses can show it in Meta's developer preview.

## Support

Chief is free. If you want to support the work, you can send a donation with PayPal:

https://paypal.me/lugovelb

## License

MIT. See [LICENSE](LICENSE).
