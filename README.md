# Tracker Hub

A personal Progressive Web App that keeps all your tracker links in one place.
Sign in with Google, paste a website, and it's saved to Firestore under your account.
The title is taken from the address (`my-crypto-tracker.netlify.app` → "My Crypto Tracker") unless you type your own.

- Each link shows its site's logo and an auto-generated title. The URL is not shown.
- Press **Edit** (top of the list) to show the ⠿ drag handle and ✕ delete button on every card. Drag the ⠿ handle to reorder; the order is saved to Firestore. Press **Done** to hide them again.
- Installable; opens fullscreen on Android/Chrome, standalone on iPhone.
- Data lives in Firestore. Firebase keeps your sign-in in the browser so you stay signed in.

