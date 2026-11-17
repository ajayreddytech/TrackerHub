import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// ---------- Firebase setup ----------
const configured = !firebaseConfig.apiKey.startsWith("REPLACE");
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
// Stay signed in across app restarts (Firebase keeps the session in this browser).
await setPersistence(auth, browserLocalPersistence);

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  loading: $("loading"),
  login: $("login-screen"),
  app: $("app-screen"),
  loginBtn: $("login-btn"),
  signOutBtn: $("signout-btn"),
  installBtn: $("install-btn"),
  userName: $("user-name"),
  form: $("add-form"),
  url: $("url-input"),
  addBtn: $("add-btn"),
  list: $("list"),
  empty: $("empty"),
  status: $("status"),
  loginStatus: $("login-status"),
};

let unsubscribeLinks = null;
let items = []; // latest links, in display order
let pendingItems = null; // snapshot received while a drag is in progress
let dragging = null; // state of the active drag, if any

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

// ---------- Install (Android/Chrome and desktop Chromium) ----------
let deferredInstall = null;
const isInstalled = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstall = event;
  if (!isInstalled()) els.installBtn.hidden = false;
});

window.addEventListener("appinstalled", () => {
  deferredInstall = null;
  els.installBtn.hidden = true;
});

els.installBtn.addEventListener("click", async () => {
  const prompt = deferredInstall;
  if (!prompt) return;
  prompt.prompt();
  await prompt.userChoice;
  deferredInstall = null;
  els.installBtn.hidden = true;
});

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
    items = [];
    lastSignature = null;
    return;
  }

  els.login.hidden = true;
  els.app.hidden = false;
  els.userName.textContent = user.displayName || user.email || "";
  listenToLinks(user.uid);
});

// ---------- Firestore: users/{uid}/links/{linkId} ----------
// Each link has an `order` number. Lower numbers show first. New links get a
// negative number (newest first), and a drag-and-drop writes 0, 1, 2, ... in the new order.
function linksCollection(uid) {
  return collection(db, "users", uid, "links");
}

function linkRef(id) {
  return doc(db, "users", auth.currentUser.uid, "links", id);
}

function sortKey(item) {
  if (typeof item.order === "number") return item.order;
  const ms = item.createdAt?.toMillis?.();
  return ms !== undefined ? -ms : -Date.now();
}

// Only the rendered list is sorted here. Nothing is written on load, so there is no write loop.
function listenToLinks(uid) {
  unsubscribeLinks = onSnapshot(
    linksCollection(uid),
    (snapshot) => {
      const list = snapshot.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => sortKey(a) - sortKey(b));
      if (dragging) {
        pendingItems = list; // don't redraw under the finger; apply after the drop
        return;
      }
      items = list;
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
    showStatus("Enter a valid website address, like netlify.com");
    return;
  }

  const title = titleFromUrl(url).slice(0, 120);

  els.addBtn.disabled = true;
  showStatus("");
  try {
    await addDoc(linksCollection(auth.currentUser.uid), {
      url,
      title,
      order: -Date.now(),
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
    await deleteDoc(linkRef(item.id));
  } catch (err) {
    showStatus(friendlyError(err));
  }
}

// ---------- Rendering (textContent only, never innerHTML, so stored data can't inject markup) ----------
let lastSignature = null;

// Only rebuild the cards when something visible changed, so hover and clicks are never interrupted.
function renderLinks(list) {
  const signature = list.map((i) => `${i.id}|${i.order}|${i.title}|${i.url}`).join("\n");
  if (signature !== lastSignature) {
    lastSignature = signature;
    els.list.replaceChildren(...list.map(makeCard));
  }
  els.empty.hidden = list.length > 0;
}

function makeCard(item) {
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.id = item.id;

  const link = document.createElement("a");
  link.className = "card-main";
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";

  const title = document.createElement("span");
  title.className = "card-title";
  title.textContent = item.title;

  link.append(makeLogo(item), title);

  // The grip is the only drag target, so scrolling and tapping the card still work normally.
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "card-handle";
  handle.setAttribute("aria-label", `Drag to reorder ${item.title}`);
  handle.title = "Drag to reorder";
  handle.textContent = "⠿";
  handle.addEventListener("pointerdown", startDrag);
  handle.addEventListener("pointermove", onDragMove);
  handle.addEventListener("pointerup", onDragEnd);
  handle.addEventListener("pointercancel", onDragEnd);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "icon-btn";
  del.setAttribute("aria-label", `Delete ${item.title}`);
  del.title = "Delete";
  del.textContent = "✕";
  del.addEventListener("click", () => removeLink(item));

  card.append(link, handle, del);
  return card;
}

// The site's own icon first (the most accurate), then icon services, then the first letter of the title.
function logoSources(url) {
  const host = encodeURIComponent(hostOf(url));
  return [
    `https://${host}/favicon.ico`,
    `https://icons.duckduckgo.com/ip3/${host}.ico`,
    `https://www.google.com/s2/favicons?domain=${host}&sz=128`,
  ];
}

function makeLogo(item) {
  const wrap = document.createElement("span");
  wrap.className = "card-logo";

  const sources = logoSources(item.url);
  let next = 0;

  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", () => {
    next++;
    if (next < sources.length) {
      img.src = sources[next];
      return;
    }
    wrap.classList.add("fallback");
    wrap.textContent = (item.title.charAt(0) || "?").toUpperCase();
  });
  img.src = sources[0];

  wrap.append(img);
  return wrap;
}

// ---------- Drag to reorder (pointer events, so it works with touch and mouse) ----------
const AUTO_SCROLL_EDGE = 90; // px from the top/bottom of the screen where scrolling starts
const AUTO_SCROLL_STEP = 14; // px per frame

function currentIds() {
  return [...els.list.children].map((card) => card.dataset.id);
}

function startDrag(event) {
  if (event.button > 0) return;
  event.preventDefault();
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  const card = handle.closest(".card");
  dragging = {
    card,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    startIds: currentIds(),
    frame: null,
  };
  card.classList.add("dragging");
  document.body.classList.add("is-reordering");
  dragging.frame = requestAnimationFrame(autoScroll);
}

function onDragMove(event) {
  if (!dragging || event.pointerId !== dragging.pointerId) return;
  dragging.x = event.clientX;
  dragging.y = event.clientY;
  moveDraggedCard(dragging.x, dragging.y);
}

// Moves the dragged card into the slot under the pointer.
function moveDraggedCard(x, y) {
  const under = document.elementFromPoint(x, y)?.closest(".card");
  if (!under || under === dragging.card || under.parentElement !== els.list) return;
  const cards = [...els.list.children];
  const draggedFirst = cards.indexOf(dragging.card) < cards.indexOf(under);
  els.list.insertBefore(dragging.card, draggedFirst ? under.nextSibling : under);
}

// Scrolls the page when the finger is near the top or bottom edge.
function autoScroll() {
  if (!dragging) return;
  const { y } = dragging;
  let delta = 0;
  if (y < AUTO_SCROLL_EDGE) delta = -AUTO_SCROLL_STEP;
  else if (y > window.innerHeight - AUTO_SCROLL_EDGE) delta = AUTO_SCROLL_STEP;
  if (delta) {
    window.scrollBy(0, delta);
    moveDraggedCard(dragging.x, dragging.y);
  }
  dragging.frame = requestAnimationFrame(autoScroll);
}

async function onDragEnd(event) {
  if (!dragging || event.pointerId !== dragging.pointerId) return;
  const { card, startIds, frame } = dragging;
  cancelAnimationFrame(frame);
  dragging = null;
  card.classList.remove("dragging");
  document.body.classList.remove("is-reordering");

  const newIds = currentIds();
  const changed = newIds.join("|") !== startIds.join("|");

  if (!changed) {
    if (pendingItems) {
      items = pendingItems;
      pendingItems = null;
      renderLinks(items);
    }
    return;
  }

  // Use the latest data if a snapshot arrived mid-drag, then store the new order.
  if (pendingItems) {
    items = pendingItems;
    pendingItems = null;
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = newIds.map((id) => byId.get(id)).filter(Boolean);

  const batch = writeBatch(db);
  let writes = 0;
  ordered.forEach((item, index) => {
    if (item.order !== index) {
      batch.update(linkRef(item.id), { order: index });
      item.order = index;
      writes++;
    }
  });
  items = ordered;
  renderLinks(items);

  if (writes === 0) return;
  try {
    await batch.commit();
  } catch (err) {
    showStatus(friendlyError(err));
  }
}

// ---------- Service worker (app files only; data never goes through it) ----------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
