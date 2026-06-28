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
  collection as fsCollection, query, where, getDocs,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─────────────────────────────────────────────────────────────────
// CONFIGURATION
// Edit ALLOWED_EMAILS to control who can sign in.
// ─────────────────────────────────────────────────────────────────

const ALLOWED_EMAILS = [
  'jroy4@umbc.edu',
  // 'friend@gmail.com',
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
let wantlists      = {};     // v2 multi-list format (see getListEntries)
let collUnsub      = null;   // Firestore listener unsubscribe fns
let wlUnsub        = null;

let allSets        = null;   // cached list of all TCG sets
let cardDataMap    = {};     // { cardId: apiCardObject } for modal lookups

let activeTab      = 'checklist';
let modalCardId    = null;
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
// WANTLIST HELPERS — multi-list data model
// ─────────────────────────────────────────────────────────────────

function getWantlistLists() {
  return wantlists._lists || {};
}

function getListEntries(listId) {
  return Object.entries(wantlists)
    .filter(([k, v]) => !k.startsWith('_') && v.list === listId)
    .map(([pid, info]) => ({ pokemonId: pid, ...info }));
}

function getAllListEntries() {
  return Object.entries(wantlists)
    .filter(([k]) => !k.startsWith('_'))
    .map(([pid, info]) => ({ pokemonId: pid, ...info }));
}

function isTracked(pokemonId) {
  return !!(wantlists[pokemonId] && !pokemonId.startsWith('_'));
}

async function migrateWantlistIfNeeded(data, uid) {
  if (!data || Object.keys(data).length === 0) return data || {};
  if (data._version === 2) return data;

  const defaultListId = `list_${Date.now()}`;
  const migrated = {
    _version: 2,
    _lists: {
      [defaultListId]: { name: 'My Wishlist', createdAt: serverTimestamp(), order: 0 }
    },
    _defaultList: defaultListId,
  };

  for (const [pid, info] of Object.entries(data)) {
    migrated[pid] = { ...info, list: defaultListId };
  }

  await setDoc(doc(db, 'wantlists', uid), migrated);
  return migrated;
}

// ─────────────────────────────────────────────────────────────────
// AUTH — simple: guest by default, popup sign-in
// ─────────────────────────────────────────────────────────────────

document.getElementById('topbar-signin-btn').addEventListener('click', async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    if (e.code === 'auth/popup-closed-by-user') return;
    console.error('[Porydex] Sign-in error:', e.code, e.message);
    alert(`Sign-in failed: ${e.code || e.message}`);
  }
});

document.getElementById('sign-out-btn').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async user => {
  if (!user) {
    teardown();
    currentUser = null;
    isGuest = true;
    await bootApp();
    return;
  }
  if (!ALLOWED_EMAILS.includes(user.email)) {
    console.warn('[Porydex] Not on access list:', user.email);
    alert('Your account is not on the access list for this tracker.');
    await signOut(auth);
    return;
  }
  currentUser = user;
  isGuest = false;
  console.info('[Porydex] signed in —', user.email, '| uid:', user.uid);
  await bootApp();
});

async function bootApp() {
  const photo = document.getElementById('user-photo');
  const signOutBtn = document.getElementById('sign-out-btn');
  const signInBtn = document.getElementById('topbar-signin-btn');

  if (isGuest) {
    photo.hidden = true;
    document.getElementById('user-name').textContent = '';
    signOutBtn.style.display = 'none';
    signInBtn.style.display = '';
  } else {
    if (currentUser.photoURL) { photo.src = currentUser.photoURL; photo.hidden = false; }
    else photo.hidden = true;
    document.getElementById('user-name').textContent = currentUser.displayName || currentUser.email;
    signOutBtn.style.display = '';
    signOutBtn.textContent = 'Sign out';
    signInBtn.style.display = 'none';
  }

  // Guests have no account — hide every write-capable control
  document.getElementById('manage-sets-btn').classList.toggle('hidden', isGuest);
  document.getElementById('modal-owned-btn').classList.toggle('hidden', isGuest);
  document.getElementById('new-list-btn').classList.toggle('hidden', isGuest);
  document.getElementById('share-my-profile-btn').classList.toggle('hidden', isGuest);
  document.getElementById('public-profile-toggle').style.display = isGuest ? 'none' : '';

  // Hide tabs that don't apply to guests
  document.querySelectorAll('.tab-btn[data-tab="checklist"]').forEach(b => b.classList.toggle('hidden', isGuest));
  document.querySelectorAll('.tab-btn[data-tab="wantlists"]').forEach(b => b.classList.toggle('hidden', isGuest));

  // Reveal the app now that auth state is resolved and UI is configured
  document.getElementById('app').classList.remove('hidden');

  if (isGuest) {
    trackedSets = []; collection = {}; wantlists = {};
    await fetchAllSets();
    handleRoute();
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

  const userData = userSnap.data() || {};
  const freshSets = userData.trackedSets || [];
  document.getElementById('public-profile-cb').checked = !!userData.publicProfile;

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

  // Check for profile URL on load
  handleRoute();
}

function teardown() {
  if (collUnsub) { collUnsub(); collUnsub = null; }
  if (wlUnsub)   { wlUnsub();   wlUnsub  = null; }
  currentUser = null; isGuest = false; trackedSets = []; collection = {}; wantlists = {}; cardDataMap = {};
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
  wlUnsub = onSnapshot(doc(db, 'wantlists', currentUser.uid), async snap => {
    const data = snap.data() || {};
    if (Object.keys(data).length && data._version !== 2) {
      wantlists = await migrateWantlistIfNeeded(data, currentUser.uid);
    } else {
      wantlists = data;
    }
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

window.addToWantlist = async function(pokemonId, displayName, listId) {
  const ref = doc(db, 'wantlists', currentUser.uid);
  const targetList = listId || wantlists._defaultList;

  if (!targetList) {
    const newListId = `list_${Date.now()}`;
    const init = {
      _version: 2,
      _lists: { [newListId]: { name: 'My Wishlist', createdAt: serverTimestamp(), order: 0 } },
      _defaultList: newListId,
      [pokemonId]: { displayName, addedAt: serverTimestamp(), list: newListId },
    };
    await setDoc(ref, init, { merge: true });
  } else {
    const delta = { [pokemonId]: { displayName, addedAt: serverTimestamp(), list: targetList } };
    await updateDoc(ref, delta).catch(async e => {
      if (e.code === 'not-found') {
        const newListId = `list_${Date.now()}`;
        await setDoc(ref, {
          _version: 2,
          _lists: { [newListId]: { name: 'My Wishlist', createdAt: serverTimestamp(), order: 0 } },
          _defaultList: newListId,
          [pokemonId]: { displayName, addedAt: serverTimestamp(), list: newListId },
        });
      } else throw e;
    });
  }

  document.querySelectorAll(`.track-all-btn[data-pokemon="${CSS.escape(pokemonId)}"]`).forEach(btn => {
    btn.textContent = `✓ Tracking all ${displayName}`;
    btn.classList.add('tracked');
  });
  dismissListPicker();
};

window.removeFromWantlist = async function(pokemonId) {
  const ref = doc(db, 'wantlists', currentUser.uid);
  await updateDoc(ref, { [pokemonId]: deleteField() });
};

// ─────────────────────────────────────────────────────────────────
// WANTLIST — LIST MANAGEMENT
// ─────────────────────────────────────────────────────────────────

window.createWishlist = async function(name) {
  if (!name || !currentUser) return;
  const listId = `list_${Date.now()}`;
  const ref = doc(db, 'wantlists', currentUser.uid);
  const lists = getWantlistLists();
  const order = Object.keys(lists).length;
  const delta = {
    _version: 2,
    [`_lists.${listId}`]: { name, createdAt: serverTimestamp(), order },
  };
  if (!wantlists._defaultList) delta._defaultList = listId;
  await updateDoc(ref, delta).catch(async e => {
    if (e.code === 'not-found') {
      await setDoc(ref, {
        _version: 2,
        _lists: { [listId]: { name, createdAt: serverTimestamp(), order: 0 } },
        _defaultList: listId,
      });
    } else throw e;
  });
};

window.renameWishlist = async function(listId) {
  const lists = getWantlistLists();
  const current = lists[listId]?.name || '';
  const name = prompt('Rename list:', current);
  if (!name || name === current) return;
  const ref = doc(db, 'wantlists', currentUser.uid);
  await updateDoc(ref, { [`_lists.${listId}.name`]: name });
};

window.deleteWishlist = async function(listId) {
  const lists = getWantlistLists();
  const name = lists[listId]?.name || 'this list';
  if (!confirm(`Delete "${name}" and all its tracked Pokémon?`)) return;

  const ref = doc(db, 'wantlists', currentUser.uid);
  const updates = { [`_lists.${listId}`]: deleteField() };
  const entries = getListEntries(listId);
  for (const e of entries) updates[e.pokemonId] = deleteField();
  if (wantlists._defaultList === listId) {
    const remaining = Object.keys(lists).filter(k => k !== listId);
    updates._defaultList = remaining[0] || deleteField();
  }
  await updateDoc(ref, updates);
};

window.setDefaultWishlist = async function(listId) {
  const ref = doc(db, 'wantlists', currentUser.uid);
  await updateDoc(ref, { _defaultList: listId });
};

window.toggleListMenu = function(listId) {
  const menu = document.getElementById(`menu-${listId}`);
  if (!menu) return;
  document.querySelectorAll('.wishlist-menu:not(.hidden)').forEach(m => {
    if (m !== menu) m.classList.add('hidden');
  });
  menu.classList.toggle('hidden');
};

window.promptNewList = function() {
  const name = prompt('New list name:');
  if (name) createWishlist(name.trim());
};

// ─────────────────────────────────────────────────────────────────
// SEARCH — LIST PICKER DROPDOWN
// ─────────────────────────────────────────────────────────────────

window.showListPicker = function(pokemonId, displayName, btn) {
  dismissListPicker();
  const lists = getWantlistLists();
  const listArr = Object.entries(lists).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));

  const picker = document.createElement('div');
  picker.className = 'list-picker';
  picker.id = 'active-list-picker';

  for (const [lid, info] of listArr) {
    const item = document.createElement('div');
    item.className = 'list-picker-item';
    item.textContent = info.name;
    if (lid === wantlists._defaultList) item.textContent += ' ★';
    item.onclick = () => addToWantlist(pokemonId, displayName, lid);
    picker.appendChild(item);
  }

  const create = document.createElement('div');
  create.className = 'list-picker-item list-picker-create';
  create.textContent = '+ New list…';
  create.onclick = async () => {
    const name = prompt('New list name:');
    if (!name) return;
    await createWishlist(name.trim());
    const newLists = getWantlistLists();
    const newest = Object.entries(newLists).sort((a, b) => (b[1].order || 0) - (a[1].order || 0))[0];
    if (newest) await addToWantlist(pokemonId, displayName, newest[0]);
    dismissListPicker();
  };
  picker.appendChild(create);

  btn.style.position = 'relative';
  btn.appendChild(picker);
};

function dismissListPicker() {
  const existing = document.getElementById('active-list-picker');
  if (existing) existing.remove();
}

document.addEventListener('click', e => {
  if (!e.target.closest('.list-picker') && !e.target.closest('.track-all-btn')) {
    dismissListPicker();
  }
});

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
    const tracked   = isTracked(pokemonId);
    const lists     = getWantlistLists();
    const multiList = Object.keys(lists).length > 1;
    const trackBtn  = isGuest ? '' : `<div style="grid-column:1/-1;padding:2px 0 6px">
  <button class="track-all-btn${tracked ? ' tracked' : ''}" data-pokemon="${esc(pokemonId)}"
    onclick="${tracked ? '' : (multiList
      ? `showListPicker('${esc(pokemonId)}','${esc(query)}',this)`
      : `addToWantlist('${esc(pokemonId)}','${esc(query)}')`)}">${tracked ? `✓ Tracking all ${esc(query)}` : `Track all ${esc(query)}`}</button>
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
  const lists = getWantlistLists();
  const listArr = Object.entries(lists).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
  const allEntries = getAllListEntries();

  if (!listArr.length && !allEntries.length) {
    el.innerHTML = isGuest
      ? `<div class="wantlist-empty"><p>Sign in with Google to build a want list.</p></div>`
      : `<div class="wantlist-empty">
      <p>No wishlists yet.</p>
      <p>Click <strong>"New List"</strong> above to create one, then go to <strong>Search</strong> to add Pokémon.</p>
    </div>`;
    return;
  }

  el.innerHTML = '<div class="loading"><div class="spinner"></div>Loading wishlists…</div>';

  let html = '';
  for (const [listId, listInfo] of listArr) {
    const entries = getListEntries(listId);
    const isDefault = wantlists._defaultList === listId;
    const readonly = isGuest;

    let totalCards = 0, totalOwned = 0;
    let pokemonHtml = '';
    for (const entry of entries) {
      let cards = [];
      try { cards = await searchPokemon(entry.displayName); } catch (_) {}
      const nOwned = cards.filter(c => collection[c.id]).length;
      totalCards += cards.length;
      totalOwned += nOwned;
      const tiles = cards.map(c => cardTile(c, { showSet: true })).join('');
      pokemonHtml += `<div class="wantlist-pokemon" data-pokemon="${esc(entry.pokemonId)}">
  <div class="wantlist-pokemon-header">
    <span class="wantlist-pokemon-name">${esc(entry.displayName)}</span>
    <span class="wantlist-pokemon-progress">${nOwned}/${cards.length}</span>
    ${readonly ? '' : `<button class="wantlist-remove" onclick="removeFromWantlist('${esc(entry.pokemonId)}')">✕</button>`}
  </div>
  <div class="card-grid">${tiles}</div>
</div>`;
    }

    const menuHtml = readonly ? '' : `<button class="wishlist-menu-btn" onclick="event.stopPropagation();toggleListMenu('${esc(listId)}')" title="List options">⋯</button>
  <div class="wishlist-menu hidden" id="menu-${esc(listId)}">
    <button onclick="renameWishlist('${esc(listId)}')">Rename</button>
    <button onclick="setDefaultWishlist('${esc(listId)}')">Set as default</button>
    <button onclick="shareList('${esc(listId)}')">Share link</button>
    <button onclick="deleteWishlist('${esc(listId)}')">Delete</button>
  </div>`;

    html += `<div class="wishlist-section" data-list-id="${esc(listId)}">
  <div class="wishlist-header" onclick="toggleWishlistSection(this)">
    <div class="wishlist-header-left">
      <span class="toggle-icon">▾</span>
      <span class="wishlist-name">${esc(listInfo.name)}</span>
      ${isDefault ? '<span class="wishlist-default-badge">Default</span>' : ''}
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <span class="wishlist-progress">${totalOwned} / ${totalCards} owned</span>
      ${menuHtml}
    </div>
  </div>
  <div class="wishlist-body">${pokemonHtml || '<p class="wishlist-empty-list">No Pokémon tracked yet. Use Search to add some.</p>'}</div>
</div>`;
  }

  el.innerHTML = html;
}

window.toggleWishlistSection = function(header) {
  const section = header.closest('.wishlist-section');
  section.classList.toggle('collapsed');
};

// ─────────────────────────────────────────────────────────────────
// COMMUNITY TAB — public user profiles
// ─────────────────────────────────────────────────────────────────

async function renderCommunity() {
  const el = document.getElementById('community-content');
  el.innerHTML = '<div class="loading"><div class="spinner"></div>Loading…</div>';

  try {
    const q2 = query(fsCollection(db, 'users'), where('publicProfile', '==', true));
    const snap = await getDocs(q2);
    let html = '';

    snap.forEach(d => {
      const uid = d.id;
      if (currentUser && uid === currentUser.uid) return;
      const data = d.data();
      const name = data.displayName || 'User';
      const photo = data.photoURL || '';
      const av = photo
        ? `<img class="friend-avatar" src="${esc(photo)}" alt="${esc(name)}">`
        : `<div class="friend-no-photo">${esc((name[0] || '?').toUpperCase())}</div>`;
      html += `<div class="friend-card" onclick="location.hash='#/profile/${esc(uid)}'">
  ${av}
  <div class="friend-info"><h3>${esc(name)}</h3></div>
</div>`;
    });

    if (!html) {
      el.innerHTML = '<div class="wantlist-empty"><p>No public profiles yet.</p></div>';
      return;
    }
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<div class="wantlist-empty"><p>Could not load profiles: ${esc(e.message)}</p></div>`;
  }
}

window.togglePublicProfile = async function(checkbox) {
  if (!currentUser) return;
  const val = checkbox.checked;
  await setDoc(doc(db, 'users', currentUser.uid), { publicProfile: val }, { merge: true });
  showToast(val ? 'Your profile is now public' : 'Your profile is now private');
};

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
// TOAST
// ─────────────────────────────────────────────────────────────────

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// ─────────────────────────────────────────────────────────────────
// SHARE
// ─────────────────────────────────────────────────────────────────

window.shareProfile = function() {
  const uid = currentUser?.uid;
  if (!uid) return;
  const url = `${location.origin}${location.pathname}#/profile/${uid}`;
  navigator.clipboard.writeText(url).then(() => showToast('Profile link copied!'));
};

window.shareList = function(listId) {
  const uid = currentUser?.uid;
  if (!uid) return;
  const url = `${location.origin}${location.pathname}#/profile/${uid}/${listId}`;
  navigator.clipboard.writeText(url).then(() => showToast('List link copied!'));
};

// ─────────────────────────────────────────────────────────────────
// PROFILE VIEW + HASH ROUTING
// ─────────────────────────────────────────────────────────────────

let activeRoute = null;

const VALID_TABS = ['checklist', 'search', 'wantlists', 'community'];

function parseRoute() {
  const hash = location.hash.slice(1);
  const profileMatch = hash.match(/^\/profile\/([^/]+)(?:\/(.+))?$/);
  if (profileMatch) return { type: 'profile', uid: profileMatch[1], listId: profileMatch[2] || null };
  const tabMatch = hash.match(/^\/(\w+)$/);
  if (tabMatch && VALID_TABS.includes(tabMatch[1])) return { type: 'tab', tab: tabMatch[1] };
  if (hash === '/welcome' || hash === '/home' || hash === '/' || hash === '') return { type: 'home' };
  return { type: 'home' };
}

function handleRoute() {
  activeRoute = parseRoute();
  if (activeRoute.type === 'profile') {
    showProfileView(activeRoute.uid, activeRoute.listId);
  } else if (activeRoute.type === 'tab') {
    hideProfileView();
    switchTab(activeRoute.tab, true);
  } else if (activeRoute.type === 'home') {
    hideProfileView();
    showWelcome();
  }
}

function showWelcome() {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'home'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById('welcome-view').classList.remove('hidden');
  document.querySelector('.tab-bar')?.classList.remove('hidden');
}

function showProfileView(uid, listId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById('profile-view').classList.remove('hidden');
  document.querySelector('.tab-bar')?.classList.add('hidden');
  renderProfile(uid, listId);
}

function hideProfileView() {
  document.getElementById('profile-view').classList.add('hidden');
  document.querySelector('.tab-bar')?.classList.remove('hidden');
}

async function renderProfile(uid, filterListId) {
  const headerEl = document.getElementById('profile-header');
  const listsEl = document.getElementById('profile-wishlists');
  headerEl.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  listsEl.innerHTML = '';

  try {
    const [uSnap, cSnap, wSnap] = await Promise.all([
      getDoc(doc(db, 'users', uid)),
      getDoc(doc(db, 'collections', uid)),
      getDoc(doc(db, 'wantlists', uid)),
    ]);

    if (!uSnap.exists()) {
      headerEl.innerHTML = '<div class="loading">User not found.</div>';
      return;
    }

    const userData = uSnap.data();
    const coll = { ...cSnap.data() }; delete coll.updatedAt;
    const wlData = wSnap.data() || {};

    const name = userData.displayName || 'User';
    const photo = userData.photoURL || '';
    const setsCount = (userData.trackedSets || []).length;
    const cardsOwned = Object.keys(coll).length;

    headerEl.innerHTML = `
      ${photo
        ? `<img class="profile-avatar" src="${esc(photo)}" alt="${esc(name)}">`
        : `<div class="profile-no-photo">${esc((name[0] || '?').toUpperCase())}</div>`}
      <div class="profile-name">${esc(name)}</div>
      <div class="profile-stats-row">
        <span>${setsCount} set${setsCount !== 1 ? 's' : ''} tracked</span>
        <span>${cardsOwned} card${cardsOwned !== 1 ? 's' : ''} owned</span>
      </div>`;

    const lists = wlData._lists || {};
    const listArr = Object.entries(lists).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));

    if (!listArr.length) {
      listsEl.innerHTML = '<div class="wantlist-empty"><p>No wishlists yet.</p></div>';
      return;
    }

    const filtered = filterListId ? listArr.filter(([id]) => id === filterListId) : listArr;
    if (filterListId && !filtered.length) {
      listsEl.innerHTML = '<div class="wantlist-empty"><p>List not found.</p></div>';
      return;
    }

    let html = '';
    for (const [listId, listInfo] of filtered) {
      const entries = Object.entries(wlData)
        .filter(([k, v]) => !k.startsWith('_') && v.list === listId)
        .map(([pid, info]) => ({ pokemonId: pid, ...info }));

      let totalCards = 0, totalOwned = 0, pokemonHtml = '';
      for (const entry of entries) {
        let cards = [];
        try { cards = await searchPokemon(entry.displayName); } catch (_) {}
        const nOwned = cards.filter(c => coll[c.id]).length;
        totalCards += cards.length;
        totalOwned += nOwned;
        pokemonHtml += `<div class="wantlist-pokemon">
  <div class="wantlist-pokemon-header">
    <span class="wantlist-pokemon-name">${esc(entry.displayName)}</span>
    <span class="wantlist-pokemon-progress">${nOwned}/${cards.length}</span>
  </div>
  <div class="card-grid">${cards.map(c => cardTile(c, { readonly: true, showSet: true })).join('')}</div>
</div>`;
      }

      html += `<div class="wishlist-section" data-list-id="${esc(listId)}">
  <div class="wishlist-header" onclick="toggleWishlistSection(this)">
    <div class="wishlist-header-left">
      <span class="toggle-icon">▾</span>
      <span class="wishlist-name">${esc(listInfo.name)}</span>
    </div>
    <span class="wishlist-progress">${totalOwned} / ${totalCards} owned</span>
  </div>
  <div class="wishlist-body">${pokemonHtml || '<p class="wishlist-empty-list">Empty list.</p>'}</div>
</div>`;
    }

    if (filterListId) {
      html = `<div style="padding:8px 16px">
  <a href="#/profile/${esc(uid)}" style="font-size:.78rem;color:var(--dark)">← See all wishlists</a>
</div>` + html;
    }

    listsEl.innerHTML = html;
  } catch (e) {
    headerEl.innerHTML = `<div class="loading">Failed to load profile: ${esc(e.message)}</div>`;
  }
}

document.getElementById('back-from-profile').addEventListener('click', () => {
  location.hash = '';
});

document.getElementById('copy-profile-link').addEventListener('click', () => {
  navigator.clipboard.writeText(location.href).then(() => showToast('Link copied!'));
});

window.addEventListener('hashchange', handleRoute);

// ─────────────────────────────────────────────────────────────────
// TAB SWITCHING
// ─────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn =>
  btn.addEventListener('click', () => {
    location.hash = `#/${btn.dataset.tab}`;
  })
);

window.switchTab = async function switchTab(tab, fromRouter) {
  activeTab = tab;
  if (!fromRouter) location.hash = `#/${tab}`;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById(`tab-${tab}`).classList.remove('hidden');
  document.querySelector('.tab-bar')?.classList.remove('hidden');
  if (tab === 'wantlists') await renderWantlists();
  if (tab === 'community') await renderCommunity();
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
