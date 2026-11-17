# Tracker Hub

A personal Progressive Web App that keeps all your tracker links in one place.
Sign in with Google, paste a website, and it's saved to Firestore under your account.
The title is taken from the address (`my-crypto-tracker.netlify.app` → "My Crypto Tracker") unless you type your own.

- Phone: one link per row. Desktop: 2–4 columns depending on width.
- Installable; opens fullscreen on Android/Chrome, standalone on iPhone.
- Data only in Firestore. Nothing is written to localStorage, IndexedDB or cookies by the app.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page shell (sign-in + app screens) |
| `styles.css` | Layout, dark/light theme, responsive grid |
| `app.js` | Google sign-in, add/delete links, Firestore sync |
| `firebase-config.js` | **Your Firebase project settings (edit this)** |
| `firestore.rules` | Security rules: each user sees only their own links |
| `manifest.webmanifest` | Install settings (name, icons, fullscreen) |
| `sw.js` | Service worker: caches the app's own files only |
| `netlify.toml` | Netlify publish settings and cache headers |
| `icons/` | App icons |

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> → **Add project** (name it e.g. `tracker-hub`).
2. **Build → Firestore Database → Create database** → pick a location → start in **production mode**.
3. **Build → Authentication → Get started → Sign-in method → Google → Enable**, choose a support email, save.
4. **Project settings (gear) → General → Your apps → Add app → Web (</>)**. Register it and copy the `firebaseConfig` values into `firebase-config.js`.
5. **Firestore → Rules**: paste the contents of `firestore.rules` and **Publish**.

## 2. Deploy on Netlify

1. Push this folder to a GitHub repo (or drag the folder into Netlify's **Deploy manually** page).
2. Netlify → **Add new site** → import the repo. No build command is needed; publish directory is `.`.
3. Note your site URL, e.g. `https://tracker-hub.netlify.app`.
4. In Firebase: **Authentication → Settings → Authorized domains → Add domain** → enter your Netlify host (`tracker-hub.netlify.app`). Without this, Google sign-in fails.

## 3. Install it like an app

- **Android (Chrome):** menu (⋮) → **Install app** / **Add to Home screen**. It opens fullscreen.
- **iPhone (Safari):** Share → **Add to Home Screen**. iOS has no true fullscreen for web apps, so it opens standalone (no browser bar).
- **Desktop (Chrome/Edge):** install icon in the address bar.

## Things to know

- **Sign-in each time the app is fully closed.** Firebase normally keeps your login in browser storage. This app disables that to honour "nothing in local storage". To keep users signed in across restarts, change `inMemoryPersistence` to `browserLocalPersistence` in `app.js`; that is a one-line change.
- Firebase's Google sign-in popup may use short-lived browser storage internally for its own handshake. The app code does not save your data or session itself.
- The service worker caches only this site's HTML/CSS/JS/icons so the app loads instantly. Your links are never cached by it.
- Firestore's offline cache is memory-only, so adding links while offline will not sync until you are back online.
- Publishing `firestore.rules` is required; without it the app shows "Firestore blocked this request".
