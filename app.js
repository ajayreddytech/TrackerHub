import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  setPersistence,
  inMemoryPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// ---------- Firebase setup ----------
const configured = !firebaseConfig.apiKey.startsWith("REPLACE");
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Firestore's default cache is memory-only (no IndexedDB), so nothing is kept on the device.
const db = getFirestore(app);
// Login session is kept in memory only: nothing is saved to the browser's storage.
// Trade-off: you sign in again each time the app is fully closed and reopened.
await setPersistence(auth, inMemoryPersistence);

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  loading: $("loading"),
  login: $("login-screen"),
  app: $("app-screen"),
  loginBtn: $("login-btn"),
  signOutBtn: $("signout-btn"),
  userName: $("user-name"),
  form: $("add-form"),
  url: $("url-input"),
  title: $("title-input"),
  addBtn: $("add-btn"),
  list: $("list"),
  empty: $("empty"),
  status: $("status"),
  loginStatus: $("login-status"),
};

let unsubscribeLinks = null;

// Shows the message on whichever screen is visible (sign-in or app).
function showStatus(message) {
  for (const el of [els.status, els.loginStatus]) {
    el.textContent = message || "";
    el.hidden = !message;
  }
}

function friendlyError(err) {
  switch (err?.code) {
    case "auth/unauthorized-domain":
      return "This site's domain is not authorized in Firebase. Add it under Authentication → Settings → Authorized domains.";
    case "auth/operation-not-allowed":
      return "Google sign-in is not enabled. Turn it on under Authentication → Sign-in method.";
    case "permission-denied":
      return "Firestore blocked this request. Check your security rules and that you are signed in.";
    case "unavailable":
      return "Can't reach Firestore right now. Check your internet connection and try again.";
    default:
      return err?.message || "Something went wrong.";
  }
}

// ---------- URL + title helpers ----------
const GENERIC_LABELS = new Set(["app", "m", "go", "www", "api", "mobile", "web", "links"]);

function normalizeUrl(raw) {
  let value = raw.trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = "https://" + value;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return url.href;
  } catch {
    return null;
  }
}

function hostOf(href) {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}

// "https://my-crypto-tracker.netlify.app/x" -> "My Crypto Tracker"
function titleFromUrl(href) {
  const host = hostOf(href);
  const labels = host.split(".");
  let label = labels[0];
  if (GENERIC_LABELS.has(label.toLowerCase()) && labels.length > 2) label = labels[1];

  const words = label
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // "MyTracker" -> "My Tracker"
    .split(/[\s\-_+.]+/)
    .filter(Boolean);

  const title = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return title || host;
}

// ---------- Auth ----------
if (!configured) {
  showStatus("Firebase is not configured yet. Edit firebase-config.js with your project settings.");
}

els.loginBtn.addEventListener("click", async () => {
  if (!configured) return;
  els.loginBtn.disabled = true;
  showStatus("");
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (err?.code !== "auth/popup-closed-by-user" && err?.code !== "auth/cancelled-popup-request") {
      showStatus(friendlyError(err));
    }
  } finally {
    els.loginBtn.disabled = false;
  }
});

els.signOutBtn.addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  els.loading.hidden = true;

  if (unsubscribeLinks) {
    unsubscribeLinks();
    unsubscribeLinks = null;
  }

  if (!user) {
    els.app.hidden = true;
    els.login.hidden = false;
    els.list.replaceChildren();
    els.empty.hidden = true;
    return;
  }

  els.login.hidden = true;
  els.app.hidden = false;
  els.userName.textContent = user.displayName || user.email || "";
  listenToLinks(user.uid);
});

// ---------- Firestore: users/{uid}/links/{linkId} ----------
function linksCollection(uid) {
  return collection(db, "users", uid, "links");
}

function listenToLinks(uid) {
  const q = query(linksCollection(uid), orderBy("createdAt", "desc"));
  unsubscribeLinks = onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderLinks(items);
    },
    (err) => showStatus(friendlyError(err))
  );
}

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!auth.currentUser) return;

  const url = normalizeUrl(els.url.value);
  if (!url) {
    showStatus("Enter a valid website address, like my-tracker.netlify.app");
    return;
  }

  const title = (els.title.value.trim() || titleFromUrl(url)).slice(0, 120);

  els.addBtn.disabled = true;
  showStatus("");
  try {
    await addDoc(linksCollection(auth.currentUser.uid), {
      url,
      title,
      createdAt: serverTimestamp(),
    });
    els.form.reset();
    els.url.focus();
  } catch (err) {
    showStatus(friendlyError(err));
  } finally {
    els.addBtn.disabled = false;
  }
});

async function removeLink(item) {
  if (!auth.currentUser) return;
  if (!confirm(`Delete "${item.title}"?`)) return;
  try {
    await deleteDoc(doc(db, "users", auth.currentUser.uid, "links", item.id));
  } catch (err) {
    showStatus(friendlyError(err));
  }
}

// ---------- Rendering (textContent only, never innerHTML, so stored data can't inject markup) ----------
function renderLinks(items) {
  els.list.replaceChildren(...items.map(makeCard));
  els.empty.hidden = items.length > 0;
}

function makeCard(item) {
  const card = document.createElement("article");
  card.className = "card";

  const link = document.createElement("a");
  link.className = "card-main";
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";

  const title = document.createElement("span");
  title.className = "card-title";
  title.textContent = item.title;

  const host = document.createElement("span");
  host.className = "card-host";
  host.textContent = hostOf(item.url);

  link.append(title, host);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "icon-btn";
  del.setAttribute("aria-label", `Delete ${item.title}`);
  del.title = "Delete";
  del.textContent = "✕";
  del.addEventListener("click", () => removeLink(item));

  card.append(link, del);
  return card;
}

// ---------- Service worker (app files only; data never goes through it) ----------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
