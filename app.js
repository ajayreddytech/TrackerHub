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
  editBtn: $("edit-btn"),
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
let editing = false; // when true, cards show the drag handle and delete button

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

// Common words used in tracker names. A run-together name such as "mycryptotracker" is split
// only when every piece is in this list. Otherwise it stays as one word (so "netlify" is not broken up).
const KNOWN_WORDS = new Set((
  "a i an and at by for from in of on or the to with my our your go app hub pro plus max lite " +
  "net web site online daily weekly monthly track tracker tracking crypto coin coins bitcoin ethereum " +
  "money budget expense expenses finance financial stock stocks price prices market markets fund funds " +
  "invest investment investments portfolio trade trading trader dividend earnings profit loss gain value " +
  "savings saving debt loan loans tax taxes invoice invoices bill bills spend spending cost costs rate rates " +
  "income worth networth cash card cards bank credit pay payment payments wallet currency forex exchange " +
  "fitness workout workouts health habit habits sleep water weight diet food calorie calories nutrition " +
  "protein meal meals recipe recipes gym run running runner step steps walk walking cycle cycling swim " +
  "yoga meditation mood journal diary note notes task tasks todo planner plan timer time study reading " +
  "book books movie movies game games score scores sport sports fantasy league goal goals school grade " +
  "grades class classes learn learning course courses language work office team project projects client " +
  "clients sales sale deal deals shop store shopping list lists order orders delivery package parcel " +
  "shipping post mail email news feed blog blogs chat social friend friends family kids pet pets plant " +
  "plants garden car fuel gas mileage power energy solar electric electricity bike home house rent " +
  "mortgage utility utilities insurance subscription subscriptions recurring chore chores clean cleaning " +
  "medicine medication symptom symptoms period fertility blood pressure sugar glucose heart body fat muscle " +
  "lift lifting reps sets race marathon golf tennis chess puzzle puzzles word words quiz quizzes music song " +
  "songs playlist podcast video videos photo photos art design dev code coding bug bugs issue issues ticket " +
  "tickets sheet sheets data dashboard report reports stats stat analytics metric metrics monitor monitoring " +
  "status uptime server servers cloud host hosting domain domains speed test tests check checker finder " +
  "search scanner converter calculator calc generator maker builder editor viewer reader writer manager " +
  "organizer helper assistant coach mentor city state country world global first last next new old big " +
  "small great super smart easy quick fast simple personal private open free total full live real true " +
  "one two three all best top count counter counters log logs logger booking air fire earth sun moon star " +
  "stars sky dark light blue green red black white gold silver token tokens nft nfts chain block blocks " +
  "defi eth btc quit smoke smoking alcohol drink drinks coffee tea day days week weeks month months year " +
  "years hour hours minute minutes set way up down out off over under get make made now here this that"
).split(" "));

// Splits a lowercase run-together word into known words, e.g. "mycryptotracker" -> ["my", "crypto", "tracker"].
// Returns null if the word cannot be fully split into known words.
function splitKnownWords(word) {
  const n = word.length;
  const best = new Array(n + 1).fill(null);
  best[0] = [];
  for (let i = 0; i < n; i++) {
    if (!best[i]) continue;
    for (let j = i + 1; j <= n; j++) {
      const piece = word.slice(i, j);
      if (!KNOWN_WORDS.has(piece)) continue;
      const candidate = [...best[i], piece];
      if (!best[j] || candidate.length < best[j].length) best[j] = candidate;
    }
  }
  return best[n];
}

// "https://my-crypto-tracker.netlify.app/x" -> "My Crypto Tracker"
function titleFromUrl(href) {
  const host = hostOf(href);
  const labels = host.split(".");
  let label = labels[0];
  if (GENERIC_LABELS.has(label.toLowerCase()) && labels.length > 2) label = labels[1];

  const words = label
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // "MyTracker" -> "My Tracker"
    .replace(/([a-zA-Z])(\d)/g, "$1 $2") // "tracker2" -> "tracker 2"
    .replace(/(\d)([a-zA-Z])/g, "$1 $2") // "2go" -> "2 go"
    .split(/[\s\-_+.]+/)
    .filter(Boolean)
    .flatMap((w) => {
      // Split run-together lowercase words such as "mycryptotracker" when every piece is known.
      const lower = w.toLowerCase();
      if (/^[a-z]{6,}$/.test(lower)) {
        const pieces = splitKnownWords(lower);
        if (pieces) return pieces;
      }
      return [w];
    });

  const title = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return title || host;
}

// Titles are always generated from the address (there is no custom title yet), so the
// display title is recalculated each time. This also fixes titles saved before the splitting rules existed.
function displayTitle(item) {
  return titleFromUrl(item.url) || item.title || "";
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
    setEditing(false);
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

// One Edit button for the whole list. In edit mode every card shows its drag handle and delete button.
function setEditing(on) {
  editing = on;
  els.list.classList.toggle("editing", on);
  els.editBtn.textContent = on ? "Done" : "Edit";
  els.editBtn.setAttribute("aria-pressed", String(on));
}

els.editBtn.addEventListener("click", () => setEditing(!editing));

async function removeLink(item) {
  if (!auth.currentUser) return;
  if (!confirm(`Delete "${displayTitle(item)}"?`)) return;
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
  const signature = list.map((i) => `${i.id}|${i.order}|${i.url}`).join("\n");
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
  title.textContent = displayTitle(item);

  link.append(makeLogo(item), title);

  // The grip is the only drag target, so scrolling and tapping the card still work normally.
  // Grip and delete are hidden until Edit is pressed (see .list.editing in styles.css).
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "card-handle card-action";
  handle.setAttribute("aria-label", `Drag to reorder ${displayTitle(item)}`);
  handle.title = "Drag to reorder";
  handle.textContent = "⠿";
  handle.addEventListener("pointerdown", startDrag);
  handle.addEventListener("pointermove", onDragMove);
  handle.addEventListener("pointerup", onDragEnd);
  handle.addEventListener("pointercancel", onDragEnd);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "icon-btn card-action";
  del.setAttribute("aria-label", `Delete ${displayTitle(item)}`);
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
    wrap.textContent = (displayTitle(item).charAt(0) || "?").toUpperCase();
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
