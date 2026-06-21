// ─────────────────────────────────────────────────────────────────
// Pokemon Card Tracker — app.js
// Requires firebase-config.js to expose window.FIREBASE_CONFIG
// ─────────────────────────────────────────────────────────────────

import { initializeApp }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache,
  doc, getDoc, setDoc, updateDoc, deleteField, onSnapshot, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─────────────────────────────────────────────────────────────────
// CONFIGURATION
// Edit ALLOWED_EMAILS to control who can sign in.
// Add friend UIDs to FRIENDS after they sign in once
// (their UID is printed to the browser console on first sign-in).
// ─────────────────────────────────────────────────────────────────

const ALLOWED_EMAILS = [
  'jroy4@umbc.edu',
  // 'friend@gmail.com',
];

const FRIENDS = [
  // { uid: 'PASTE_UID_HERE', displayName: 'Friend Name', photoURL: '' },
];

const TCG_API = 'https://api.pokemontcg.io/v2';

const FINISH_LABELS = {
  '1stEditionHolofoil': '1st Ed. Holo',
  'unlimitedHolofoil':  'Unlimited Holo',
  'holofoil':           'Holofoil',
  '1stEdition':         '1st Edition',
  'unlimited':          'Unlimited',
  'normal':             'Normal',
  'reverseHolofoil':    'Reverse Holo',
};

// ─────────────────────────────────────────────────────────────────
// FIREBASE INIT
// ─────────────────────────────────────────────────────────────────

const fbApp = initializeApp(window.FIREBASE_CONFIG);
const auth  = getAuth(fbApp);
const db    = initializeFirestore(fbApp, { localCache: persistentLocalCache() });

// ─────────────────────────────────────────────────────────────────
// APP STATE
// ─────────────────────────────────────────────────────────────────

let currentUser    = null;
let isGuest        = false;  // true for read-only anonymous sessions
let trackedSets    = [];     // set IDs the user has chosen to track
let collection     = {};     // { cardId: true } owned cards
let wantlists      = {};     // { pokemonId: { displayName } }
let collUnsub      = null;   // Firestore listener unsubscribe fns
let wlUnsub        = null;

let allSets        = null;   // cached list of all TCG sets
let cardDataMap    = {};     // { cardId: apiCardObject } for modal lookups

let activeTab      = 'checklist';
let modalCardId    = null;
let viewingFriend  = null;   // { uid, displayName }
let pendingSetSel  = null;   // Set() in-progress selection in set picker

// ─────────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmt$(v) { return v != null ? `$${Number(v).toFixed(2)}` : '—'; }

function ebayUrl(card) {
  const q = `pokemon ${card.name} ${card.set?.name || ''} ${card.number}`;
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`;
}

function bestPrice(prices) {
  if (!prices) return null;
  const order = ['1stEditionHolofoil','unlimitedHolofoil','holofoil','1stEdition','unlimited','normal','reverseHolofoil'];
  for (const f of [...order, ...Object.keys(prices)]) {
    if (prices[f]?.market) return prices[f].market;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────

document.getElementById('google-signin-btn').addEventListener('click', async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    if (e.code === 'auth/popup-closed-by-user') return;
    console.error('[Porydex] Sign-in error:', e.code, e.message);
    const msg = e.code === 'auth/unauthorized-domain'
      ? `This domain (${location.hostname}) isn't authorized for sign-in yet. Add it in Firebase Console → Authentication → Settings → Authorized domains.`
      : `Sign-in failed (${e.code || 'unknown error'}). Please try again.`;
    document.getElementById('signin-error').textContent = msg;
  }
});

// "Continue without signing in" — browse read-only, no Firebase auth session at all.
document.getElementById('guest-signin-btn').addEventListener('click', async () => {
  currentUser = null;
  isGuest = true;
  await bootApp();
});

document.getElementById('sign-out-btn').addEventListener('click', () => {
  if (isGuest) {
    teardown();
    showSignin();
  } else {
    signOut(auth);
  }
});

onAuthStateChanged(auth, async user => {
  if (!user) {
    showSignin();
    teardown();
    return;
  }
  if (!ALLOWED_EMAILS.includes(user.email)) {
    console.warn('[Porydex] Blocked — add this to ALLOWED_EMAILS:', user.email);
    document.getElementById('signin-error').textContent =
      'This tracker is private. Your account is not on the access list.';
    await signOut(auth);
    return;
  }
  currentUser = user;
  isGuest = false;
  console.info('[Tracker] signed in —', user.email, '| uid:', user.uid);
  if (!FRIENDS.some(f => f.uid === user.uid)) {
    console.info('[Tracker] To add this user to FRIENDS, paste:', `{ uid: '${user.uid}', displayName: '${user.displayName}' }`);
  }
  await bootApp();
});

async function bootApp() {
  // Populate auth bar immediately (synchronous)
  const photo = document.getElementById('user-photo');
  if (isGuest) {
    photo.hidden = true;
    document.getElementById('user-name').textContent = 'Guest';
    document.getElementById('sign-out-btn').textContent = 'Exit Guest Mode';
  } else {
    if (currentUser.photoURL) { photo.src = currentUser.photoURL; photo.hidden = false; }
    else photo.hidden = true;
    document.getElementById('user-name').textContent = currentUser.displayName || currentUser.email;
    document.getElementById('sign-out-btn').textContent = 'Sign out';
  }

  // Show the app shell right away — don't make the user wait for network
  document.getElementById('signin-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  // Guests have no account — hide every write-capable control
  document.getElementById('manage-sets-btn').classList.toggle('hidden', isGuest);
  document.getElementById('modal-owned-btn').classList.toggle('hidden', isGuest);

  if (isGuest) {
    trackedSets = []; collection = {}; wantlists = {};
    await fetchAllSets(); // warm the set list cache for Search/Friends
    await renderChecklist();
    return;
  }

  if (!localStorage.getItem('import_dismissed')) {
    document.getElementById('import-banner').classList.remove('hidden');
  }

  // Render immediately from localStorage cache (stale-while-revalidate)
  const cachedSets = JSON.parse(localStorage.getItem('porydex_tracked_sets') || 'null');
  if (cachedSets) {
    trackedSets = cachedSets;
    renderChecklist(); // don't await — let it run while Firestore loads
  }

  // Kick off Firestore + set list fetch in parallel
  const [userSnap] = await Promise.all([
    getDoc(doc(db, 'users', currentUser.uid)),
    setDoc(doc(db, 'users', currentUser.uid), {
      displayName: currentUser.displayName || '',
      email:       currentUser.email,
      photoURL:    currentUser.photoURL || '',
    }, { merge: true }),
    fetchAllSets(), // warm the IndexedDB cache now
  ]);

  const freshSets = userSnap.data()?.trackedSets || [];

  // Re-render only if tracked sets changed from the cached version
  if (JSON.stringify(freshSets) !== JSON.stringify(trackedSets)) {
    trackedSets = freshSets;
    localStorage.setItem('porydex_tracked_sets', JSON.stringify(trackedSets));
    await renderChecklist();
  } else {
    trackedSets = freshSets;
    localStorage.setItem('porydex_tracked_sets', JSON.stringify(trackedSets));
  }

  // Start Firestore listeners
  listenCollection();
  listenWantlists();
}

function teardown() {
  if (collUnsub) { collUnsub(); collUnsub = null; }
  if (wlUnsub)   { wlUnsub();   wlUnsub  = null; }
  currentUser = null; isGuest = false; trackedSets = []; collection = {}; wantlists = {}; cardDataMap = {};
}

function showSignin() {
  document.getElementById('signin-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

// ─────────────────────────────────────────────────────────────────
// FIRESTORE — COLLECTION LISTENER
// ─────────────────────────────────────────────────────────────────

function listenCollection() {
  if (collUnsub) collUnsub();
  collUnsub = onSnapshot(doc(db, 'collections', currentUser.uid), snap => {
    const data = { ...snap.data() };
    delete data.updatedAt;
    collection = data;
    // Sync all rendered tiles without re-rendering
    document.querySelectorAll('.card-tile[data-id]').forEach(tile => {
      const owned = !!collection[tile.dataset.id];
      tile.classList.toggle('owned', owned);
      const cb = tile.querySelector('input[type=checkbox]');
      if (cb && !cb.disabled) cb.checked = owned;
    });
    refreshStats();
    if (modalCardId) syncModalBtn(!!collection[modalCardId]);
  });
}

function listenWantlists() {
  if (wlUnsub) wlUnsub();
  wlUnsub = onSnapshot(doc(db, 'wantlists', currentUser.uid), snap => {
    wantlists = snap.data() || {};
    if (activeTab === 'wantlists') renderWantlists();
  });
}

// Optimistic toggle: update local state + DOM immediately, write Firestore in background
window.handleToggle = async function(checkbox, cardId) {
  if (!currentUser) return;
  const owned = checkbox.checked;
  if (owned) collection[cardId] = true; else delete collection[cardId];
  syncTiles(cardId, owned);
  refreshStats();
  if (modalCardId === cardId) syncModalBtn(owned);

  try {
    const ref = doc(db, 'collections', currentUser.uid);
    const delta = owned
      ? { [cardId]: true, updatedAt: serverTimestamp() }
      : { [cardId]: deleteField(), updatedAt: serverTimestamp() };
    await updateDoc(ref, delta).catch(async e => {
      if (e.code === 'not-found') await setDoc(ref, delta);
      else throw e;
    });
  } catch (e) {
    console.error('Write failed, reverting:', e);
    if (owned) delete collection[cardId]; else collection[cardId] = true;
    checkbox.checked = !owned;
    syncTiles(cardId, !owned);
    refreshStats();
  }
};

function syncTiles(cardId, owned) {
  document.querySelectorAll(`.card-tile[data-id="${CSS.escape(cardId)}"]`).forEach(tile => {
    tile.classList.toggle('owned', owned);
    tile.querySelectorAll('input[type=checkbox]:not(:disabled)').forEach(cb => { cb.checked = owned; });
  });
}

// ─────────────────────────────────────────────────────────────────
// FIRESTORE — TRACKED SETS + WANT LISTS WRITES
// ─────────────────────────────────────────────────────────────────

async function saveTrackedSets(ids) {
  trackedSets = ids;
  localStorage.setItem('porydex_tracked_sets', JSON.stringify(ids));
  await setDoc(doc(db, 'users', currentUser.uid), { trackedSets: ids }, { merge: true });
}

window.addToWantlist = async function(pokemonId, displayName) {
  const ref   = doc(db, 'wantlists', currentUser.uid);
  const delta = { [pokemonId]: { displayName, addedAt: serverTimestamp() } };
  await updateDoc(ref, delta).catch(async e => {
    if (e.code === 'not-found') await setDoc(ref, delta);
    else throw e;
  });
  document.querySelectorAll(`.track-all-btn[data-pokemon="${CSS.escape(pokemonId)}"]`).forEach(btn => {
    btn.textContent = `✓ Tracking all ${displayName}`;
    btn.classList.add('tracked');
  });
};

window.removeFromWantlist = async function(pokemonId) {
  const ref = doc(db, 'wantlists', currentUser.uid);
  await updateDoc(ref, { [pokemonId]: deleteField() });
};

// ─────────────────────────────────────────────────────────────────
// POKEMON TCG API + CACHE
// ─────────────────────────────────────────────────────────────────
// PERSISTENT CARD CACHE — IndexedDB, 7-day TTL
// Avoids re-hitting the Pokemon TCG API every session.
// ─────────────────────────────────────────────────────────────────

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
let _idb = null;

function openCacheDB() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('porydex-tcg-cache', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('cache');
    req.onsuccess = e => { _idb = e.target.result; resolve(_idb); };
    req.onerror = reject;
  });
}

async function cacheGet(key) {
  // L1: sessionStorage — synchronous, fast for same-session reads
  const sess = sessionStorage.getItem(key);
  if (sess) { try { return JSON.parse(sess); } catch (_) {} }

  // L2: IndexedDB — persistent across sessions
  try {
    const db = await openCacheDB();
    const entry = await new Promise((res, rej) => {
      const req = db.transaction('cache').objectStore('cache').get(key);
      req.onsuccess = e => res(e.target.result);
      req.onerror = rej;
    });
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) return null;
    // Promote to L1 so subsequent reads this session are instant
    try { sessionStorage.setItem(key, JSON.stringify(entry.data)); } catch (_) {}
    return entry.data;
  } catch (_) { return null; }
}

function cacheSet(key, data) {
  // Write to L1 synchronously so it's available immediately
  try { sessionStorage.setItem(key, JSON.stringify(data)); } catch (_) {}
  // Write to L2 in the background — don't block the caller
  openCacheDB().then(db => {
    const tx = db.transaction('cache', 'readwrite');
    tx.objectStore('cache').put({ data, ts: Date.now() }, key);
  }).catch(() => {});
}

async function tcgFetch(url) {
  const key = 'tcg__' + url.replace(TCG_API, '').replace(/\W+/g, '_').slice(0, 180);
  const hit = await cacheGet(key);
  if (hit) return hit;
  const res = await fetch(url);
  const data = await res.json();
  await cacheSet(key, data);
  return data;
}

async function fetchAllSets() {
  if (allSets) return allSets;
  const data = await tcgFetch(`${TCG_API}/sets?pageSize=250&orderBy=releaseDate&select=id,name,series,releaseDate,total`);
  allSets = data.data || [];
  return allSets;
}

async function fetchSetCards(setId) {
  const key = `cards_${setId}`;
  const hit = await cacheGet(key);
  if (hit) return hit;
  let cards = [], page = 1, total = Infinity;
  while (cards.length < total) {
    const data = await tcgFetch(
      `${TCG_API}/cards?q=set.id:${setId}&orderBy=number&pageSize=250&page=${page}` +
      `&select=id,name,number,set,images,tcgplayer`
    );
    cards.push(...(data.data || []));
    total = data.totalCount ?? cards.length;
    if (!data.data?.length) break;
    page++;
  }
  await cacheSet(key, cards);
  return cards;
}

async function searchPokemon(query) {
  const key = `search_v2_${query.toLowerCase().replace(/\W+/g, '_')}`;
  const hit = await cacheGet(key);
  if (hit) return hit;
  const data = await tcgFetch(
    `${TCG_API}/cards?q=name:${encodeURIComponent('*' + query + '*')}&pageSize=50&orderBy=set.releaseDate` +
    `&select=id,name,number,set,images,tcgplayer`
  );
  const cards = data.data || [];
  await cacheSet(key, cards);
  return cards;
}

// ─────────────────────────────────────────────────────────────────
// SHARED CARD TILE HTML
// ─────────────────────────────────────────────────────────────────

function cardTile(card, { readonly = false, showSet = false } = {}) {
  cardDataMap[card.id] = card;  // for modal lookups
  const owned  = !!collection[card.id];
  const ro     = readonly || isGuest;
  const imgSrc = card.images?.small || '';
  const price  = bestPrice(card.tcgplayer?.prices);
  const img    = imgSrc
    ? `<img class="card-img" src="${esc(imgSrc)}" alt="${esc(card.name)}" loading="lazy">`
    : `<div class="no-img">No image</div>`;

  return `<div class="card-tile${owned ? ' owned' : ''}" data-id="${esc(card.id)}" data-name="${esc(card.name.toLowerCase())}">
  <label class="owned-check${ro ? ' readonly' : ''}">
    <input type="checkbox" ${owned ? 'checked' : ''} ${ro ? 'disabled' : ''}
           onchange="handleToggle(this,'${esc(card.id)}')">
    <span class="checkmark">✓</span>
  </label>
  <div class="card-img-wrap" onclick="openModal('${esc(card.id)}')">
    ${img}<div class="card-overlay">View details</div>
  </div>
  <span class="card-name">${esc(card.name)}</span>
  <span class="card-num">${esc(card.number)}</span>
  ${price ? `<span class="card-price">~${fmt$(price)}</span>` : ''}
  ${showSet ? `<span class="card-set-badge">${esc(card.set?.name || '')}</span>` : ''}
</div>`;
}

// ─────────────────────────────────────────────────────────────────
// CHECKLIST TAB
// ─────────────────────────────────────────────────────────────────

async function renderChecklist() {
  const el = document.getElementById('checklist-content');

  if (!trackedSets.length) {
    if (isGuest) {
      el.innerHTML = `<div class="loading">
        <p style="color:#888">Sign in with Google to track your own collection.</p>
      </div>`;
      return;
    }
    el.innerHTML = `<div class="loading">
      <p style="color:#888;margin-bottom:16px">Pick some sets to start tracking your collection.</p>
      <button onclick="openSetPicker()"
        style="background:#1a1a2e;color:#fff;border:none;padding:10px 24px;border-radius:8px;font-size:.9rem;cursor:pointer">
        Choose Sets
      </button>
    </div>`;
    openSetPicker();
    return;
  }

  // Render headers immediately using the cached set list — no per-set API calls yet
  const allSetsData = await fetchAllSets();
  const setMeta = Object.fromEntries(allSetsData.map(s => [s.id, s]));

  let html = '';
  for (const setId of trackedSets) {
    const meta = setMeta[setId] || {};
    const name  = meta.name || setId;
    const total = meta.total || '?';
    html += `<section class="set-section collapsed" data-set="${esc(setId)}" data-loaded="false">
  <div class="set-header" onclick="toggleSection(this)">
    <div class="set-header-left">
      <span class="toggle-icon">▾</span>
      <span class="set-name">${esc(name)}</span>
    </div>
    <span class="set-stats" data-set-id="${esc(setId)}">— / ${total} owned</span>
  </div>
  <div class="card-grid" data-set-grid="${esc(setId)}">
    <div class="loading" style="grid-column:1/-1;padding:24px"><div class="spinner"></div></div>
  </div>
</section>`;
  }

  el.innerHTML = html || '<div class="loading">No sets found.</div>';
}

function setSection(setId, setName, total, tilesHtml) {
  return `<section class="set-section collapsed" data-set="${esc(setId)}">
  <div class="set-header" onclick="toggleSection(this)">
    <div class="set-header-left">
      <span class="toggle-icon">▾</span>
      <span class="set-name">${esc(setName)}</span>
    </div>
    <span class="set-stats" data-set-id="${esc(setId)}">0 / ${total} owned</span>
  </div>
  <div class="card-grid">${tilesHtml}</div>
</section>`;
}

window.toggleSection = async function(header) {
  const section = header.closest('.set-section, .wantlist-item');
  section.classList.toggle('collapsed');

  // Lazy-load cards the first time a set section is expanded
  if (!section.classList.contains('collapsed') && section.dataset.loaded === 'false') {
    const setId = section.dataset.set;
    const grid  = section.querySelector(`[data-set-grid]`);
    if (!setId || !grid) return;
    section.dataset.loaded = 'true';
    const cards = await fetchSetCards(setId);
    grid.innerHTML = cards.map(c => cardTile(c)).join('') || '<div class="loading">No cards found.</div>';
    applyChecklistFilters();
    refreshStats();
  }
};

window.toggleAllSections = async function() {
  const sections = [...document.querySelectorAll('#checklist-content .set-section')];
  const anyExpanded = sections.some(s => !s.classList.contains('collapsed'));
  sections.forEach(s => s.classList.toggle('collapsed', anyExpanded));
  const btn = document.getElementById('toggle-all-btn');
  if (btn) btn.textContent = anyExpanded ? 'Expand all' : 'Collapse all';

  // Lazy-load any unloaded sections that are now expanded
  if (!anyExpanded) {
    for (const section of sections) {
      if (section.dataset.loaded === 'false') {
        const setId = section.dataset.set;
        const grid  = section.querySelector(`[data-set-grid]`);
        if (!setId || !grid) continue;
        section.dataset.loaded = 'true';
        const cards = await fetchSetCards(setId);
        grid.innerHTML = cards.map(c => cardTile(c)).join('') || '';
      }
    }
    applyChecklistFilters();
    refreshStats();
  }
};

function refreshStats() {
  // Top-level checklist stats
  const allTiles   = document.querySelectorAll('#checklist-content .card-tile:not(.hidden)');
  const nOwned     = [...allTiles].filter(t => collection[t.dataset.id]).length;
  const statsEl    = document.getElementById('checklist-stats');
  if (statsEl) statsEl.textContent = `${nOwned} owned · ${allTiles.length - nOwned} missing`;

  // Per-set stats
  document.querySelectorAll('.set-stats[data-set-id]').forEach(span => {
    const tiles    = document.querySelectorAll(`.set-section[data-set="${span.dataset.setId}"] .card-tile`);
    const setOwned = [...tiles].filter(t => collection[t.dataset.id]).length;
    span.textContent = `${setOwned} / ${tiles.length} owned`;
  });
}

function applyChecklistFilters() {
  const q    = (document.getElementById('checklist-filter')?.value || '').toLowerCase();
  const miss = document.getElementById('missing-only-toggle')?.checked;
  document.querySelectorAll('#checklist-content .card-tile').forEach(tile => {
    tile.classList.toggle('hidden',
      (q && !tile.dataset.name.includes(q)) || (miss && !!collection[tile.dataset.id])
    );
  });
  refreshStats();
}

document.getElementById('checklist-filter').addEventListener('input', applyChecklistFilters);
document.getElementById('missing-only-toggle').addEventListener('change', applyChecklistFilters);

// ─────────────────────────────────────────────────────────────────
// SET PICKER
// ─────────────────────────────────────────────────────────────────

window.openSetPicker = async function() {
  const picker = document.getElementById('set-picker');
  picker.classList.remove('hidden');
  const sets = await fetchAllSets();
  pendingSetSel = new Set(trackedSets);

  // Group by series
  const byEra = {};
  for (const s of sets) (byEra[s.series] = byEra[s.series] || []).push(s);

  document.getElementById('era-groups').innerHTML = Object.entries(byEra).map(([era, list]) =>
    `<div class="era-group">
  <h4>${esc(era)}</h4>
  <div class="set-chips">
    ${list.map(s => `<span class="set-chip${pendingSetSel.has(s.id) ? ' selected' : ''}"
      onclick="toggleChip(this,'${esc(s.id)}')">${esc(s.name)}</span>`).join('')}
  </div>
</div>`).join('');
};

window.toggleChip = function(el, setId) {
  if (!pendingSetSel) pendingSetSel = new Set(trackedSets);
  if (pendingSetSel.has(setId)) { pendingSetSel.delete(setId); el.classList.remove('selected'); }
  else { pendingSetSel.add(setId); el.classList.add('selected'); }
};

document.getElementById('manage-sets-btn').addEventListener('click', openSetPicker);

document.getElementById('save-sets-btn').addEventListener('click', async () => {
  const ids = pendingSetSel ? [...pendingSetSel] : trackedSets;
  await saveTrackedSets(ids);
  document.getElementById('set-picker').classList.add('hidden');
  pendingSetSel = null;
  await renderChecklist();
});

document.getElementById('cancel-sets-btn').addEventListener('click', () => {
  document.getElementById('set-picker').classList.add('hidden');
  pendingSetSel = null;
});

// ─────────────────────────────────────────────────────────────────
// SEARCH TAB
// ─────────────────────────────────────────────────────────────────

let searchTimer = null;
let searchSeq   = 0; // guards against out-of-order responses overwriting newer results

document.getElementById('pokemon-search-input').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { document.getElementById('search-hint').textContent = 'Type at least 2 characters'; return; }
  document.getElementById('search-hint').textContent = 'Searching…';
  searchTimer = setTimeout(() => runSearch(q), 400);
});

async function runSearch(query) {
  const seq = ++searchSeq;
  const el = document.getElementById('search-results');
  el.innerHTML = '<div class="loading" style="grid-column:1/-1"><div class="spinner"></div>Searching…</div>';
  try {
    const cards = await searchPokemon(query);
    if (seq !== searchSeq) return; // a newer search has since started — discard this stale result
    document.getElementById('search-hint').textContent = `${cards.length} result${cards.length !== 1 ? 's' : ''}`;

    if (!cards.length) {
      el.innerHTML = `<div class="search-empty"><h3>No results for "${esc(query)}"</h3><p>Check spelling or try a different name.</p></div>`;
      return;
    }

    const pokemonId = query.toLowerCase().replace(/\s+/g, '_');
    const tracked   = !!wantlists[pokemonId];
    const trackBtn  = isGuest ? '' : `<div style="grid-column:1/-1;padding:2px 0 6px">
  <button class="track-all-btn${tracked ? ' tracked' : ''}" data-pokemon="${esc(pokemonId)}"
    onclick="addToWantlist('${esc(pokemonId)}','${esc(query)}')">${tracked ? `✓ Tracking all ${esc(query)}` : `Track all ${esc(query)}`}</button>
</div>`;

    el.innerHTML = trackBtn + cards.map(c => cardTile(c, { showSet: true })).join('');
  } catch (e) {
    if (seq !== searchSeq) return;
    document.getElementById('search-hint').textContent = 'Search failed';
    el.innerHTML = `<div class="search-empty"><h3>Error</h3><p>${esc(e.message)}</p></div>`;
  }
}

// ─────────────────────────────────────────────────────────────────
// WANT LISTS TAB
// ─────────────────────────────────────────────────────────────────

async function renderWantlists() {
  const el = document.getElementById('wantlists-content');
  const entries = Object.entries(wantlists);

  if (!entries.length) {
    el.innerHTML = isGuest
      ? `<div class="wantlist-empty"><p>Sign in with Google to build a want list.</p></div>`
      : `<div class="wantlist-empty">
      <p>No want lists yet.</p>
      <p>Go to <strong>Search</strong>, find a Pokémon, and click <strong>"Track all [Name]"</strong>.</p>
    </div>`;
    return;
  }

  el.innerHTML = '<div class="loading"><div class="spinner"></div>Loading want list cards…</div>';

  let html = '';
  for (const [pid, info] of entries) {
    let cards = [];
    try { cards = await searchPokemon(info.displayName); } catch (_) {}
    const nOwned = cards.filter(c => collection[c.id]).length;
    const tiles  = cards.map(c => cardTile(c, { showSet: true })).join('');
    html += `<div class="wantlist-item" data-pokemon="${esc(pid)}">
  <div class="wantlist-item-header" onclick="toggleSection(this)">
    <div class="wantlist-item-header-left">
      <span class="toggle-icon">▾</span>
      <span class="wantlist-name">${esc(info.displayName)}</span>
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <span class="wantlist-progress">${nOwned} / ${cards.length} owned</span>
      <button class="wantlist-remove"
        onclick="event.stopPropagation();removeFromWantlist('${esc(pid)}')">Remove</button>
    </div>
  </div>
  <div class="card-grid">${tiles}</div>
</div>`;
  }

  el.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────────
// FRIENDS TAB
// ─────────────────────────────────────────────────────────────────

async function renderFriendsList() {
  const el = document.getElementById('friends-list-content');
  if (!FRIENDS.length) {
    el.innerHTML = `<p style="color:#aaa;font-size:.85rem;line-height:1.6">
      No friends configured yet.<br>
      Add friend UIDs to the <code>FRIENDS</code> array in <code>app.js</code>.<br>
      (UIDs appear in the browser console when a friend signs in for the first time.)
    </p>`;
    return;
  }

  let html = '';
  for (const friend of FRIENDS) {
    try {
      const snap = await getDoc(doc(db, 'users', friend.uid));
      const data = snap.data() || {};
      const name = data.displayName || friend.displayName || 'Friend';
      const photo = data.photoURL || friend.photoURL || '';
      const av   = photo
        ? `<img class="friend-avatar" src="${esc(photo)}" alt="${esc(name)}">`
        : `<div class="friend-no-photo">${esc((name[0] || '?').toUpperCase())}</div>`;
      html += `<div class="friend-card" onclick="viewFriend('${esc(friend.uid)}','${esc(name)}')">
  ${av}
  <div class="friend-info"><h3>${esc(name)}</h3><p>${esc(data.email || '')}</p></div>
</div>`;
    } catch (_) { /* skip inaccessible friend */ }
  }
  el.innerHTML = html || '<p style="color:#aaa;font-size:.85rem">Could not load friend profiles.</p>';
}

window.viewFriend = async function(uid, displayName) {
  viewingFriend = { uid, displayName };
  document.getElementById('friends-list-view').classList.add('hidden');
  document.getElementById('friend-collection-view').classList.remove('hidden');
  document.getElementById('viewing-friend-label').textContent = `${displayName}'s collection`;

  const contentEl = document.getElementById('friend-checklist-content');
  contentEl.innerHTML = '<div class="loading"><div class="spinner"></div>Loading…</div>';

  try {
    const [uSnap, cSnap] = await Promise.all([
      getDoc(doc(db, 'users', uid)),
      getDoc(doc(db, 'collections', uid)),
    ]);
    const fSets = uSnap.data()?.trackedSets || [];
    const fColl = { ...cSnap.data() };
    delete fColl.updatedAt;

    let html = '';
    for (const setId of fSets) {
      const cards = await fetchSetCards(setId);
      if (!cards.length) continue;
      const setName = cards[0]?.set?.name || setId;
      const nOwned  = cards.filter(c => fColl[c.id]).length;
      const tiles   = cards.map(c => {
        cardDataMap[c.id] = c;
        const owned  = !!fColl[c.id];
        const imgSrc = c.images?.small || '';
        return `<div class="card-tile${owned ? ' owned' : ''}" data-id="${esc(c.id)}" data-name="${esc(c.name.toLowerCase())}">
  <label class="owned-check readonly">
    <input type="checkbox" ${owned ? 'checked' : ''} disabled>
    <span class="checkmark">✓</span>
  </label>
  <div class="card-img-wrap" onclick="openModal('${esc(c.id)}')">
    ${imgSrc ? `<img class="card-img" src="${esc(imgSrc)}" alt="${esc(c.name)}" loading="lazy">` : '<div class="no-img">No image</div>'}
    <div class="card-overlay">View details</div>
  </div>
  <span class="card-name">${esc(c.name)}</span>
  <span class="card-num">${esc(c.number)}</span>
</div>`;
      }).join('');

      html += `<section class="set-section" data-set="${esc(setId)}">
  <div class="set-header" onclick="toggleSection(this)">
    <div class="set-header-left">
      <span class="toggle-icon">▾</span>
      <span class="set-name">${esc(setName)}</span>
    </div>
    <span class="set-stats">${nOwned} / ${cards.length} owned</span>
  </div>
  <div class="card-grid">${tiles}</div>
</section>`;
    }

    contentEl.innerHTML = html || '<div class="loading">This friend has no tracked sets yet.</div>';
    applyFriendFilters();
    const t = contentEl.querySelectorAll('.card-tile').length;
    const o = contentEl.querySelectorAll('.card-tile.owned').length;
    const fStats = document.getElementById('friend-stats');
    if (fStats) fStats.textContent = `${o} owned · ${t - o} missing`;
  } catch (e) {
    contentEl.innerHTML = `<div class="loading">Failed to load: ${esc(e.message)}</div>`;
  }
};

document.getElementById('back-to-friends').addEventListener('click', () => {
  viewingFriend = null;
  document.getElementById('friend-collection-view').classList.add('hidden');
  document.getElementById('friends-list-view').classList.remove('hidden');
});

function applyFriendFilters() {
  const q    = (document.getElementById('friend-filter')?.value || '').toLowerCase();
  const miss = document.getElementById('friend-missing-toggle')?.checked;
  document.querySelectorAll('#friend-checklist-content .card-tile').forEach(tile => {
    tile.classList.toggle('hidden',
      (q && !tile.dataset.name.includes(q)) || (miss && tile.classList.contains('owned'))
    );
  });
}

document.getElementById('friend-filter').addEventListener('input', applyFriendFilters);
document.getElementById('friend-missing-toggle').addEventListener('change', applyFriendFilters);

// ─────────────────────────────────────────────────────────────────
// MODAL
// ─────────────────────────────────────────────────────────────────

window.openModal = function(cardId) {
  const card = cardDataMap[cardId];
  if (!card) return;
  modalCardId = cardId;

  const imgEl = document.getElementById('modal-img');
  const src   = card.images?.large || card.images?.small || '';
  imgEl.src   = src;
  imgEl.alt   = card.name;
  imgEl.style.display = src ? '' : 'none';

  document.getElementById('modal-name').textContent     = card.name;
  document.getElementById('modal-set-line').textContent = `${card.set?.name || ''} · #${card.number}`;
  document.getElementById('modal-ebay').href            = ebayUrl(card);

  const bulbaEl = document.getElementById('modal-bulba');
  if (card.bulbapedia) { bulbaEl.href = card.bulbapedia; bulbaEl.style.display = ''; }
  else bulbaEl.style.display = 'none';

  const prices   = card.tcgplayer?.prices || {};
  const finishes = Object.keys(prices).filter(f => Object.values(prices[f] || {}).some(v => v != null));
  document.getElementById('modal-prices').innerHTML = finishes.length
    ? `<tr><th>Finish</th><th>Low</th><th>Market</th><th>High</th></tr>` +
      finishes.map(f => {
        const p = prices[f] || {};
        return `<tr><td class="finish-label">${esc(FINISH_LABELS[f] || f)}</td>
  <td>${fmt$(p.low)}</td><td>${fmt$(p.market)}</td><td>${fmt$(p.high)}</td></tr>`;
      }).join('')
    : `<tr><td colspan="4" style="color:#bbb;font-size:.78rem">No price data available</td></tr>`;

  syncModalBtn(!!collection[cardId]);
  document.getElementById('modal-bg').classList.add('open');
};

function syncModalBtn(owned) {
  const btn = document.getElementById('modal-owned-btn');
  btn.textContent = owned ? 'Owned ✓' : 'Mark Owned';
  btn.classList.toggle('active', owned);
}

document.getElementById('modal-owned-btn').addEventListener('click', () => {
  if (!modalCardId || !currentUser) return;
  // Find a checkbox for this card and delegate to handleToggle
  const cb = document.querySelector(`.card-tile[data-id="${CSS.escape(modalCardId)}"] input:not(:disabled)`);
  if (cb) {
    cb.checked = !cb.checked;
    window.handleToggle(cb, modalCardId);
  } else {
    // Card is only in the modal (e.g., from search in a different view); toggle directly
    const owned = !collection[modalCardId];
    if (owned) collection[modalCardId] = true; else delete collection[modalCardId];
    syncModalBtn(owned);
    const ref   = doc(db, 'collections', currentUser.uid);
    const delta = owned
      ? { [modalCardId]: true, updatedAt: serverTimestamp() }
      : { [modalCardId]: deleteField(), updatedAt: serverTimestamp() };
    updateDoc(ref, delta).catch(() => setDoc(ref, delta, { merge: true }));
  }
});

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-bg').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function closeModal() {
  document.getElementById('modal-bg').classList.remove('open');
  modalCardId = null;
}

// ─────────────────────────────────────────────────────────────────
// TAB SWITCHING
// ─────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn =>
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
);

async function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById(`tab-${tab}`).classList.remove('hidden');
  if (tab === 'wantlists') await renderWantlists();
  if (tab === 'friends')   await renderFriendsList();
}

// ─────────────────────────────────────────────────────────────────
// IMPORT — owned_cards.json from export_owned.py
// ─────────────────────────────────────────────────────────────────

document.getElementById('import-trigger').addEventListener('click', () => {
  document.getElementById('import-file-input').click();
});

document.getElementById('import-file-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file || !currentUser) return;
  try {
    const data = JSON.parse(await file.text());
    if (typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a JSON object');
    await setDoc(doc(db, 'collections', currentUser.uid), { ...data, updatedAt: serverTimestamp() }, { merge: true });
    document.getElementById('import-banner').classList.add('hidden');
    localStorage.setItem('import_dismissed', '1');
    alert(`Imported ${Object.keys(data).length} owned cards. Your collection is now synced to your account.`);
    await renderChecklist();
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
  e.target.value = '';
});

document.getElementById('import-dismiss').addEventListener('click', () => {
  document.getElementById('import-banner').classList.add('hidden');
  localStorage.setItem('import_dismissed', '1');
});
