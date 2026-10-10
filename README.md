# Solar Dynamic Builder (DPB)

- GitHub Pages serves the repo root: `index.html`, `sw.js`, `manifest.json`, `dpb-fs.js`, `dpb-fs2-core.js`, `dpb-fs2.js`, `dpb-config.js`.
- The Android app is built by `.github/workflows/build-apk.yml`: it copies the web files above into `www/` automatically, then runs Capacitor. There is no `www/` folder to maintain by hand.
- `android-native/` holds the print plugin (`MainActivity.java`, `DpbPrintPlugin.java`).
- `backend/Code.gs` is the Google Apps Script (Drive backup). `firestore.rules` is pasted into the Firebase console.
