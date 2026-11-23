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
  updateDoc,
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
  cancelBtn: $("cancel-btn"),
  viewChecklistBtn: $("view-checklist"),
  viewLinksBtn: $("view-links"),
  userName: $("user-name"),
  form: $("add-form"),
  url: $("url-input"),
  addBtn: $("add-btn"),
  list: $("list"),
  empty: $("empty"),
  status: $("status"),
  loginStatus: $("login-status"),
  editDialog: $("edit-dialog"),
  editForm: $("edit-form"),
  editTitle: $("edit-title"),
  editUrl: $("edit-url"),
  editLogo: $("edit-logo"),
  editLogoImg: $("edit-logo-img"),
  editSave: $("edit-save"),
  editCancel: $("edit-cancel"),
  editStatus: $("edit-status"),
};

let unsubscribeLinks = null;
let items = []; // latest links, in display order
let pendingItems = null; // snapshot received while a drag is in progress
let dragging = null; // state of the active drag, if any
let editing = false; // when true, cards show the drag handle, edit and delete buttons
let editTarget = null; // the link currently open in the edit dialog
let view = "checklist"; // what the list shows: "checklist" (default) or "links"
let query = ""; // text in the search bar; filters the list as you type
let checkItems = []; // checklist items from Firestore, in display order
let checkDraft = null; // copy of the checklist while it is being edited (null when not editing)
let unsubscribeChecklist = null;

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

// A title the user typed (customTitle) wins. Otherwise the title is generated from the address,
// so it is recalculated each time. This also fixes titles saved before the splitting rules existed.
function displayTitle(item) {
  return capitalizeWords((item.customTitle || "").trim() || titleFromUrl(item.url) || item.title || "");
}

// Capital first letter of every word, so typed titles like "best crypto tracker" show as "Best Crypto Tracker".
function capitalizeWords(text) {
  return text.replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_, before, letter) => before + letter.toUpperCase());
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
  if (unsubscribeChecklist) {
    unsubscribeChecklist();
    unsubscribeChecklist = null;
  }

  if (!user) {
    els.app.hidden = true;
    els.login.hidden = false;
    els.list.replaceChildren();
    els.empty.hidden = true;
    items = [];
    checkItems = [];
    checkDraft = null;
    lastSignature = null;
    setEditing(false);
    return;
  }

  els.login.hidden = true;
  els.app.hidden = false;
  els.userName.textContent = user.displayName || user.email || "";
  listenToLinks(user.uid);
  listenToChecklist(user.uid);
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
      if (view === "links") render();
    },
    (err) => showStatus(friendlyError(err))
  );
}

// The search bar also adds: text that is a website address and is not in the list yet gets added.
// Anything else only filters the list.
els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!auth.currentUser) return;

  const text = els.url.value.trim();
  if (!text) return;

  const url = normalizeUrl(text);
  if (!url) {
    if (!currentSource().some(matchesQuery)) {
      showStatus(`No match for "${text}". Paste a website address, like netlify.com, to add it.`);
    }
    return;
  }

  if (currentSource().some((item) => item.url === url)) {
    showStatus("That website is already in your list.");
    return;
  }

  // Editing the checklist: the new item goes into the draft and is saved with the Save button.
  if (view === "checklist" && checkDraft !== null) {
    checkDraft.push({ id: `new-${Date.now()}-${checkDraft.length}`, url, customTitle: "", isNew: true });
    els.url.value = "";
    query = "";
    showStatus("");
    render();
    els.url.focus();
    return;
  }

  const uid = auth.currentUser.uid;
  const title = titleFromUrl(url).slice(0, 120);

  els.addBtn.disabled = true;
  showStatus("");
  try {
    if (view === "links") {
      await addDoc(linksCollection(uid), {
        url,
        title,
        order: -Date.now(),
        createdAt: serverTimestamp(),
      });
    } else {
      // New checklist items go to the bottom.
      await addDoc(checklistCollection(uid), {
        url,
        title,
        customTitle: "",
        order: Date.now(),
        createdAt: serverTimestamp(),
      });
    }
    els.url.value = "";
    query = "";
    render();
    els.url.focus();
  } catch (err) {
    showStatus(friendlyError(err));
  } finally {
    els.addBtn.disabled = false;
  }
});

// ---------- Views, edit mode and the search bar ----------
// The list shows the checklist (default) or the links. One Edit button serves both:
// links edit in place (every card shows its handle and delete button), while the checklist edits a draft
// that is only saved when you press Save.
function setEditing(on) {
  editing = on;
  render();
}

function setView(next) {
  if (next === view) return;
  if (checkDraft !== null) {
    showStatus("Save or cancel your checklist changes first.");
    return;
  }
  view = next;
  editing = false;
  query = "";
  els.url.value = "";
  lastSignature = null;
  showStatus("");
  render();
}

els.viewChecklistBtn.addEventListener("click", () => setView("checklist"));
els.viewLinksBtn.addEventListener("click", () => setView("links"));

els.editBtn.addEventListener("click", () => {
  if (view === "checklist") toggleChecklistEdit();
  else setEditing(!editing);
});
els.cancelBtn.addEventListener("click", cancelChecklistEdit);

els.url.addEventListener("input", () => {
  query = els.url.value;
  showStatus("");
  render();
});

// ---------- Checklist: users/{uid}/checklist/{id} ----------
// Each item has an `order` like links. `doneOn` holds the date it was checked (YYYY-MM-DD), so an item
// counts as unchecked on a new day without any reset job.
function checklistCollection(uid) {
  return collection(db, "users", uid, "checklist");
}

function checkRef(id) {
  return doc(db, "users", auth.currentUser.uid, "checklist", id);
}

function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isDoneToday(item) {
  return item.doneOn === todayKey();
}

function listenToChecklist(uid) {
  unsubscribeChecklist = onSnapshot(
    checklistCollection(uid),
    (snapshot) => {
      checkItems = snapshot.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => sortKey(a) - sortKey(b));
      // While the draft is open, don't redraw it under the user's typing.
      if (view === "checklist" && checkDraft === null) render();
    },
    (err) => showStatus(friendlyError(err))
  );
}

async function toggleDone(item) {
  if (!auth.currentUser) return;
  try {
    await updateDoc(checkRef(item.id), { doneOn: isDoneToday(item) ? "" : todayKey() });
  } catch (err) {
    showStatus(friendlyError(err));
  }
}

function toggleChecklistEdit() {
  if (checkDraft !== null) {
    saveChecklist();
    return;
  }
  checkDraft = checkItems.map((item) => ({
    id: item.id,
    url: item.url,
    customTitle: item.customTitle || "",
    isNew: false,
  }));
  showStatus("");
  render();
}

function cancelChecklistEdit() {
  checkDraft = null;
  showStatus("");
  render();
}

// Writes the whole draft in one batch: removed rows are deleted, new rows are added, and every row gets its position.
async function saveChecklist() {
  if (!auth.currentUser || checkDraft === null) return;

  const rows = [];
  for (const row of checkDraft) {
    const url = normalizeUrl(row.url);
    if (!url) {
      showStatus(`"${row.url.trim() || "An empty row"}" is not a valid website address. Fix it, then save again.`);
      return;
    }
    rows.push({ ...row, url, customTitle: row.customTitle.trim().slice(0, 120) });
  }

  const uid = auth.currentUser.uid;
  const batch = writeBatch(db);
  const kept = new Set(rows.filter((row) => !row.isNew).map((row) => row.id));
  for (const old of checkItems) {
    if (!kept.has(old.id)) batch.delete(checkRef(old.id));
  }
  rows.forEach((row, index) => {
    const data = {
      url: row.url,
      title: titleFromUrl(row.url).slice(0, 120),
      customTitle: row.customTitle,
      order: index,
    };
    if (row.isNew) batch.set(doc(checklistCollection(uid)), { ...data, createdAt: serverTimestamp() });
    else batch.update(checkRef(row.id), data);
  });

  checkDraft = null;
  showStatus("");
  render();
  try {
    await batch.commit();
  } catch (err) {
    showStatus(friendlyError(err));
  }
}

// Drag order inside the draft: keep every row, including ones hidden by the search.
function orderDraft(ids) {
  const byId = new Map(checkDraft.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

async function removeLink(item) {
  if (!auth.currentUser) return;
  if (!confirm(`Delete "${displayTitle(item)}"?`)) return;
  try {
    await deleteDoc(linkRef(item.id));
  } catch (err) {
    showStatus(friendlyError(err));
  }
}

// ---------- Edit dialog: title, address and logo ----------
function showEditStatus(message) {
  els.editStatus.textContent = message || "";
  els.editStatus.hidden = !message;
}

// Shows the logo the link will get: the custom one if valid, otherwise the automatic one for the address.
function updateLogoPreview() {
  const custom = els.editLogo.value.trim() ? normalizeUrl(els.editLogo.value) : null;
  const site = normalizeUrl(els.editUrl.value);
  const src = custom || (site ? logoSources(site)[0] : "");
  els.editLogoImg.hidden = !src;
  els.editLogoImg.removeAttribute("src");
  if (src) els.editLogoImg.src = src;
}

els.editLogoImg.addEventListener("error", () => {
  els.editLogoImg.hidden = true;
});
els.editLogoImg.addEventListener("load", () => {
  els.editLogoImg.hidden = false;
});
els.editLogo.addEventListener("input", updateLogoPreview);
els.editUrl.addEventListener("input", updateLogoPreview);

function openEditor(item) {
  editTarget = item;
  els.editTitle.value = displayTitle(item);
  els.editTitle.placeholder = titleFromUrl(item.url);
  els.editUrl.value = item.url;
  els.editLogo.value = item.customLogo || "";
  showEditStatus("");
  updateLogoPreview();
  els.editDialog.showModal();
  els.editTitle.focus();
}

els.editCancel.addEventListener("click", () => els.editDialog.close());
els.editDialog.addEventListener("close", () => {
  editTarget = null;
});

els.editForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!editTarget || !auth.currentUser) return;

  const url = normalizeUrl(els.editUrl.value);
  if (!url) {
    showEditStatus("Enter a valid website address, like netlify.com");
    return;
  }

  let customLogo = "";
  if (els.editLogo.value.trim()) {
    customLogo = normalizeUrl(els.editLogo.value) || "";
    if (!customLogo) {
      showEditStatus("Enter a valid logo address, like https://example.com/logo.png");
      return;
    }
  }

  const customTitle = els.editTitle.value.trim().slice(0, 120);

  els.editSave.disabled = true;
  showEditStatus("");
  try {
    // Writes all three fields, so an empty title or logo goes back to the automatic one.
    await updateDoc(linkRef(editTarget.id), { url, customTitle, customLogo });
    els.editDialog.close();
  } catch (err) {
    showEditStatus(friendlyError(err));
  } finally {
    els.editSave.disabled = false;
  }
});

// ---------- Rendering (textContent only, never innerHTML, so stored data can't inject markup) ----------
let lastSignature = null;

// Only rebuild the cards when something visible changed, so hover and clicks are never interrupted.
function renderLinks(list) {
  const visible = list.filter(matchesQuery);
  const signature = visible
    .map((i) => JSON.stringify([i.id, i.order, i.url, i.customTitle || "", i.customLogo || ""]))
    .join("\n");
  if (signature !== lastSignature) {
    lastSignature = signature;
    els.list.replaceChildren(...visible.map(makeCard));
  }
  setEmptyState(visible.length);
}

function renderChecklist() {
  const drafting = checkDraft !== null;
  const source = drafting ? checkDraft : checkItems;
  // Checked-off items vanish from the daily checklist; they come back on a new day.
  const visible = source.filter((item) => matchesQuery(item) && (drafting || !isDoneToday(item)));
  els.list.replaceChildren(
    ...visible.map((item) => (drafting ? makeCheckEditRow(item) : makeCheckRow(item)))
  );
  setEmptyState(visible.length);
}

// One render for whichever view is showing, plus the Edit/Save/Cancel buttons and the search placeholder.
function render() {
  updateEditControls();
  if (view === "links") renderLinks(items);
  else renderChecklist();
}

// Edit button icons: pencil while idle, check mark while editing (Done / Save).
const ICON_ATTRS = 'width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const PENCIL_ICON = `<svg ${ICON_ATTRS}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const CHECK_ICON = `<svg ${ICON_ATTRS}><path d="M20 6 9 17l-5-5"/></svg>`;

function updateEditControls() {
  const onLinks = view === "links";
  const on = onLinks ? editing : checkDraft !== null;
  els.list.classList.toggle("editing", on);
  els.editBtn.querySelector(".btn-label").textContent = !on ? "Edit" : onLinks ? "Done" : "Save";
  els.editBtn.querySelector(".btn-icon").innerHTML = on ? CHECK_ICON : PENCIL_ICON;
  els.editBtn.setAttribute("aria-pressed", String(on));
  els.cancelBtn.hidden = onLinks || !on;
  els.viewChecklistBtn.setAttribute("aria-pressed", String(!onLinks));
  els.viewLinksBtn.setAttribute("aria-pressed", String(onLinks));
  els.url.placeholder = onLinks
    ? "Search links, or paste a website to add it"
    : "Search checklist, or paste a website to add it";
}

function searching() {
  return query.trim() !== "";
}

// The search matches the title or the website address.
function matchesQuery(item) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return displayTitle(item).toLowerCase().includes(q) || item.url.toLowerCase().includes(q);
}

// The rows of the view on screen (the draft while the checklist is being edited).
function currentSource() {
  return view === "links" ? items : (checkDraft ?? checkItems);
}

function setEmptyState(visibleCount) {
  els.empty.hidden = visibleCount > 0;
  if (visibleCount > 0) return;
  if (searching()) {
    els.empty.textContent = `No matches for "${query.trim()}". Paste a website address to add it.`;
  } else if (view === "links") {
    els.empty.textContent = "No links yet. Add your first tracker above.";
  } else if (checkDraft === null && checkItems.length > 0) {
    els.empty.textContent = "All done for today.";
  } else {
    els.empty.textContent = "Your checklist is empty. Paste a website above to add it.";
  }
}

// Checklist row for daily use: a box to check off, the logo and title (tap to open the site).
function makeCheckRow(item) {
  const done = isDoneToday(item);
  const card = document.createElement("article");
  card.className = done ? "card check-card done" : "card check-card";
  card.dataset.id = item.id;

  const box = document.createElement("button");
  box.type = "button";
  box.className = "check-box";
  box.setAttribute("role", "checkbox");
  box.setAttribute("aria-checked", String(done));
  box.setAttribute("aria-label", `Done: ${displayTitle(item)}`);
  box.textContent = done ? "✓" : "";
  box.addEventListener("click", () => toggleDone(item));

  const link = document.createElement("a");
  link.className = "card-main";
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";

  const title = document.createElement("span");
  title.className = "card-title";
  title.textContent = displayTitle(item);

  link.append(makeLogo(item), title);
  card.append(box, link);
  return card;
}

// Checklist row while editing: drag handle, title and address fields, and a remove button.
// Changes go to the draft object; nothing is saved until Save.
function makeCheckEditRow(item) {
  const card = document.createElement("article");
  card.className = "card check-card is-edit";
  card.dataset.id = item.id;

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "card-handle card-action";
  handle.setAttribute("aria-label", "Drag to reorder");
  handle.title = "Drag to reorder";
  handle.textContent = "⠿";
  handle.addEventListener("pointerdown", startDrag);
  handle.addEventListener("pointermove", onDragMove);
  handle.addEventListener("pointerup", onDragEnd);
  handle.addEventListener("pointercancel", onDragEnd);

  const fields = document.createElement("div");
  fields.className = "check-fields";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "input check-input";
  titleInput.maxLength = 120;
  titleInput.placeholder = titleFromUrl(item.url);
  // Start from the title the card shows, so you edit it instead of retyping it.
  titleInput.value = displayTitle(item);
  titleInput.setAttribute("aria-label", "Title");
  titleInput.addEventListener("input", () => {
    item.customTitle = titleInput.value;
  });

  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.inputMode = "url";
  urlInput.className = "input check-input";
  urlInput.value = item.url;
  urlInput.setAttribute("aria-label", "Website address");
  urlInput.autocapitalize = "off";
  urlInput.autocomplete = "off";
  urlInput.spellcheck = false;
  urlInput.addEventListener("input", () => {
    item.url = urlInput.value;
  });

  fields.append(titleInput, urlInput);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "icon-btn card-action";
  del.setAttribute("aria-label", `Remove ${displayTitle(item)}`);
  del.title = "Remove";
  del.textContent = "✕";
  del.addEventListener("click", () => {
    checkDraft = checkDraft.filter((row) => row !== item);
    render();
  });

  card.append(handle, fields, del);
  return card;
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
  // Grip, edit and delete are hidden until Edit is pressed (see .list.editing in styles.css).
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

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "icon-btn card-action";
  edit.setAttribute("aria-label", `Edit ${displayTitle(item)}`);
  edit.title = "Edit";
  edit.textContent = "✎";
  edit.addEventListener("click", () => openEditor(item));

  const del = document.createElement("button");
  del.type = "button";
  del.className = "icon-btn card-action";
  del.setAttribute("aria-label", `Delete ${displayTitle(item)}`);
  del.title = "Delete";
  del.textContent = "✕";
  del.addEventListener("click", () => removeLink(item));

  card.append(link, handle, edit, del);
  return card;
}

// The logo the user chose (if any) first, then the site's own icon (the most accurate),
// then icon services, then the first letter of the title.
function logoSources(url, customLogo = "") {
  const host = encodeURIComponent(hostOf(url));
  const automatic = [
    `https://${host}/favicon.ico`,
    `https://icons.duckduckgo.com/ip3/${host}.ico`,
    `https://www.google.com/s2/favicons?domain=${host}&sz=128`,
  ];
  return customLogo ? [customLogo, ...automatic] : automatic;
}

function makeLogo(item) {
  const wrap = document.createElement("span");
  wrap.className = "card-logo";

  const sources = logoSources(item.url, item.customLogo);
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
  // While searching, the list shows only some rows, so reordering is paused until the search is cleared.
  if (searching()) return;
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

  // Checklist: reorder the draft only. Nothing is written until Save.
  if (view === "checklist") {
    if (checkDraft !== null) checkDraft = orderDraft(currentIds());
    return;
  }

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
