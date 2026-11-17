# Tracker Hub

A personal Progressive Web App that keeps all your tracker links in one place.
Sign in with Google, paste a website, and it's saved to Firestore under your account.
The title is taken from the address (`my-crypto-tracker.netlify.app` → "My Crypto Tracker") unless you type your own.

- Each link shows its site's logo and an auto-generated title. The URL is not shown.
- Press **Edit** (top of the list) to show the ⠿ drag handle and ✕ delete button on every card. Drag the ⠿ handle to reorder; the order is saved to Firestore. Press **Done** to hide them again.
- Installable; opens fullscreen on Android/Chrome, standalone on iPhone.
- Data lives in Firestore. Firebase keeps your sign-in in the browser so you stay signed in.

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

- **Staying signed in:** the app uses `browserLocalPersistence`, so you stay signed in after closing the app. To require sign-in every time, change it to `inMemoryPersistence` in `app.js`.
- **Logos** are loaded from Google's favicon service using each site's domain, so that domain is sent to Google. If you don't want that, remove `makeLogo` in `app.js` and show only the first letter.
- The service worker caches only this site's HTML/CSS/JS/icons so the app loads instantly. Your links are never cached by it.
- Firestore's offline cache is memory-only, so adding links while offline will not sync until you are back online.
- Publishing `firestore.rules` is required; without it the app shows "Firestore blocked this request".
