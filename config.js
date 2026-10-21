/* Chief settings.
   Edit only the values inside the quotes. Leave the names on the left alone.
   The demo works before you change anything.
   Replace the three YOUR_... values before sending messages from the glasses.
   Steps: README.md, the checklist, then "Edit the settings in the browser". */
window.CHIEF_CONFIG = {
  // Paste the access key from https://web3forms.com
  // A long id with dashes. Anyone with it can email your inbox.
  web3formsKey: "YOUR_WEB3FORMS_KEY",

  // Paste the random id FormSubmit emails you after you confirm (https://formsubmit.co).
  // Letters and numbers only. Do not paste your email address.
  // Used only if Web3Forms does not answer. Leave the placeholder to skip this backup.
  formsubmitId: "YOUR_FORMSUBMIT_ID",

  // Make up a long random topic name for live updates (https://ntfy.sh).
  // Letters, numbers, and dashes. Anyone who knows it can post to it.
  // Do not keep the placeholder, and do not use a short or famous name.
  ntfyTopic: "YOUR_NTFY_TOPIC",

  // Leave this unless you run your own ntfy server.
  ntfyServer: "https://ntfy.sh",

  // Leave this. ./feed.json is the file next to the page (GitHub Pages too).
  feedUrl: "./feed.json",

  // Leave the empty quotes unless new replies are slow to appear.
  // Then use your own repository names, for example:
  // "https://api.github.com/repos/YOUR_NAME/YOUR_REPO/contents/feed.json?ref=main"
  apiFeedUrl: "",

  // Leave the empty quotes to use this browser's time zone.
  // Or set a zone such as "America/Chicago".
  timeZone: "",

  // Label used on incoming replies.
  assistantName: "Chief",
};
