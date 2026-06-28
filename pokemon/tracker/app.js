// ─────────────────────────────────────────────────────────────────
// Porydex — app.js
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
// ─────────────────────────────────────────────────────────────────

const ALLOWED_EMAILS = [
  'jroy4@umbc.edu',
  'ahmedkzing@gmail.com',
  'kschris37@gmail.com',
  'jroy297@gmail.com',
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
let isGuest        = false;
let collection     = {};     // { cardId: true } owned cards
let wantlists      = {};     // v3 multi-list format
let collUnsub      = null;
let wlUnsub        = null;

let allSets        = null;
let cardDataMap    = {};     // { cardId: apiCardObject } for modal lookups

let activeTab      = 'search';
let modalCardId    = null;
let activeRoute    = null;

// Multi-select state
let selectMode     = false;
let selectedCards  = new Set();
let selectedSets   = new Set();
let addingToList   = null;    // list ID when in "adding to list" mode
let selectionContext = 'search'; // 'search', 'list', or 'collection'
let viewingListId  = null;    // which list detail is open
let viewingCollection = false; // true when viewing My Collection

// Search filter state
let activeFilters  = [];      // [{ type, value, label }]
let searchTimer    = null;
let searchSeq      = 0;

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

function userName(data) {
  return data?.customName || data?.displayName || 'User';
}

// ─────────────────────────────────────────────────────────────────
// V3 LIST HELPERS
// ─────────────────────────────────────────────────────────────────

function getLists() {
  return wantlists._lists || {};
}

function getListItems(listId) {
  return Object.entries(wantlists)
    .filter(([k, v]) => !k.startsWith('_') && v.list === listId)
    .map(([itemId, info]) => ({ itemId, ...info }));
}

async function resolveListCards(listId) {
  const items = getListItems(listId);
  const allCards = [];
  const setItems = items.filter(i => i.type === 'set');
  const cardItems = items.filter(i => i.type === 'card');

  for (const item of setItems) {
    const cards = await fetchSetCards(item.setId);
    allCards.push(...cards);
  }

  if (cardItems.length) {
    const bySet = {};
    for (const item of cardItems) {
      (bySet[item.setId] = bySet[item.setId] || []).push(item.cardId);
    }
    for (const [setId, ids] of Object.entries(bySet)) {
      const cards = await fetchSetCards(setId);
      const idSet = new Set(ids);
      allCards.push(...cards.filter(c => idSet.has(c.id)));
    }
  }

  const seen = new Set();
  const deduped = allCards.filter(c => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  deduped.sort((a, b) => {
    const setCmp = (a.set?.releaseDate || '').localeCompare(b.set?.releaseDate || '');
    if (setCmp !== 0) return setCmp;
    return (parseInt(a.number) || 0) - (parseInt(b.number) || 0);
  });
  return deduped;
}

async function addItemsToList(listId, cards, sets) {
  const ref = doc(db, 'wantlists', currentUser.uid);
  const delta = {};
  let counter = 0;
  const ts = Date.now();

  for (const setId of (sets || [])) {
    delta[`item_${ts}_s${counter++}`] = { type: 'set', setId, list: listId };
  }
  for (const card of (cards || [])) {
    delta[`item_${ts}_c${counter++}`] = {
      type: 'card', cardId: card.id, setId: card.set?.id || '', list: listId
    };
  }

  if (!Object.keys(delta).length) return;

  await updateDoc(ref, delta).catch(async e => {
    if (e.code === 'not-found') {
      await setDoc(ref, { _version: 3, _lists: { [listId]: { name: 'My List', createdAt: serverTimestamp(), order: 0 } }, ...delta });
    } else throw e;
  });
}

window.removeItem = async function(itemId) {
  const ref = doc(db, 'wantlists', currentUser.uid);
  await updateDoc(ref, { [itemId]: deleteField() });
};

window.createList = async function(name) {
  if (!name || !currentUser) return null;
  const listId = `list_${Date.now()}`;
  const ref = doc(db, 'wantlists', currentUser.uid);
  const lists = getLists();
  const order = Object.keys(lists).length;
  const delta = { _version: 3, [`_lists.${listId}`]: { name, createdAt: serverTimestamp(), order } };
  await updateDoc(ref, delta).catch(async e => {
    if (e.code === 'not-found') {
      await setDoc(ref, { _version: 3, _lists: { [listId]: { name, createdAt: serverTimestamp(), order: 0 } } });
    } else throw e;
  });
  return listId;
};

window.renameList = async function(listId) {
  const lists = getLists();
  const current = lists[listId]?.name || '';
  const name = prompt('Rename list:', current);
  if (!name || name === current) return;
  await updateDoc(doc(db, 'wantlists', currentUser.uid), { [`_lists.${listId}.name`]: name });
};

window.deleteList = async function(listId) {
  const lists = getLists();
  const name = lists[listId]?.name || 'this list';
  if (!confirm(`Delete "${name}" and all its items?`)) return;
  const ref = doc(db, 'wantlists', currentUser.uid);
  const updates = { [`_lists.${listId}`]: deleteField() };
  const items = getListItems(listId);
  for (const item of items) updates[item.itemId] = deleteField();
  await updateDoc(ref, updates);
};

window.shareList = function(listId) {
  const uid = currentUser?.uid;
  if (!uid) return;
  const url = `${location.origin}${location.pathname}#/profile/${uid}/${listId}`;
  navigator.clipboard.writeText(url).then(() => showToast('List link copied!'));
};

window.shareProfile = function() {
  const uid = currentUser?.uid;
  if (!uid) return;
  const url = `${location.origin}${location.pathname}#/profile/${uid}`;
  navigator.clipboard.writeText(url).then(() => showToast('Profile link copied!'));
};

window.toggleListMenu = function(listId) {
  const menu = document.getElementById(`menu-${listId}`);
  if (!menu) return;
  document.querySelectorAll('.list-menu:not(.hidden)').forEach(m => {
    if (m !== menu) m.classList.add('hidden');
  });
  menu.classList.toggle('hidden');
};

// ─────────────────────────────────────────────────────────────────
// AUTH
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

  // Hide tabs that don't apply to guests
  document.querySelectorAll('.tab-btn[data-tab="lists"]').forEach(b => b.classList.toggle('hidden', isGuest));
  document.querySelectorAll('.tab-btn[data-tab="settings"]').forEach(b => b.classList.toggle('hidden', isGuest));
  document.getElementById('modal-owned-btn')?.classList.toggle('hidden', isGuest);

  document.getElementById('app').classList.remove('hidden');

  if (isGuest) {
    collection = {}; wantlists = {};
    handleRoute();
    await fetchAllSets();
    return;
  }

  // Route immediately so profile links don't wait for Firestore
  handleRoute();

  const [userSnap] = await Promise.all([
    getDoc(doc(db, 'users', currentUser.uid)),
    setDoc(doc(db, 'users', currentUser.uid), {
      displayName: currentUser.displayName || '',
      email:       currentUser.email,
      photoURL:    currentUser.photoURL || '',
    }, { merge: true }),
    fetchAllSets(),
  ]);

  const userData = userSnap.data() || {};
  document.getElementById('settings-name').value = userData.customName || '';
  document.getElementById('settings-bio').value = userData.bio || '';
  document.getElementById('settings-public-cb').checked = !!userData.publicProfile;
  const settingsPhoto = document.getElementById('settings-photo');
  if (currentUser.photoURL) { settingsPhoto.src = currentUser.photoURL; settingsPhoto.style.display = ''; }
  else settingsPhoto.style.display = 'none';

  listenCollection();
  listenWantlists();
}

function teardown() {
  if (collUnsub) { collUnsub(); collUnsub = null; }
  if (wlUnsub)   { wlUnsub();   wlUnsub  = null; }
  currentUser = null; isGuest = false; collection = {}; wantlists = {}; cardDataMap = {};
  exitSelectMode();
}

// ─────────────────────────────────────────────────────────────────
// FIRESTORE LISTENERS
// ─────────────────────────────────────────────────────────────────

function listenCollection() {
  if (collUnsub) collUnsub();
  collUnsub = onSnapshot(doc(db, 'collections', currentUser.uid), snap => {
    const data = { ...snap.data() };
    delete data.updatedAt;
    collection = data;
    document.querySelectorAll('.card-tile[data-id]').forEach(tile => {
      const owned = !!collection[tile.dataset.id];
      tile.classList.toggle('owned', owned);
      const cb = tile.querySelector('input[type=checkbox]');
      if (cb && !cb.disabled) cb.checked = owned;
    });
    if (modalCardId) syncModalBtn(!!collection[modalCardId]);
  });
}

function listenWantlists() {
  if (wlUnsub) wlUnsub();
  wlUnsub = onSnapshot(doc(db, 'wantlists', currentUser.uid), async snap => {
    const data = snap.data() || {};
    if (data._version === 3) {
      wantlists = data;
    } else if (Object.keys(data).length) {
      // v2 data exists — migrate it to v3 preserving entries
      console.info('[Porydex] Migrating wantlist v2 → v3');
      const listId = `list_${Date.now()}`;
      const migrated = {
        _version: 3,
        _lists: { [listId]: { name: 'My Wishlist', createdAt: serverTimestamp(), order: 0 } },
      };
      for (const [k, v] of Object.entries(data)) {
        if (k.startsWith('_')) continue;
        if (v.displayName) {
          migrated[`item_${Date.now()}_${k}`] = { type: 'card', cardId: k, setId: '', list: listId, _legacyName: v.displayName };
        }
      }
      await setDoc(doc(db, 'wantlists', currentUser.uid), migrated);
      wantlists = migrated;
    } else {
      wantlists = { _version: 3, _lists: {} };
    }
    if (activeTab === 'lists') renderLists();
  });
}

// Optimistic toggle
window.handleToggle = async function(checkbox, cardId) {
  if (!currentUser) return;
  const owned = checkbox.checked;
  if (owned) collection[cardId] = true; else delete collection[cardId];
  syncTiles(cardId, owned);
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
  }
};

function syncTiles(cardId, owned) {
  document.querySelectorAll(`.card-tile[data-id="${CSS.escape(cardId)}"]`).forEach(tile => {
    tile.classList.toggle('owned', owned);
    tile.querySelectorAll('input[type=checkbox]:not(:disabled)').forEach(cb => { cb.checked = owned; });
  });
}

// ─────────────────────────────────────────────────────────────────
// PERSISTENT CARD CACHE — IndexedDB + sessionStorage
// ─────────────────────────────────────────────────────────────────

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
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
  const sess = sessionStorage.getItem(key);
  if (sess) { try { return JSON.parse(sess); } catch (_) {} }
  try {
    const idb = await openCacheDB();
    const entry = await new Promise((res, rej) => {
      const req = idb.transaction('cache').objectStore('cache').get(key);
      req.onsuccess = e => res(e.target.result);
      req.onerror = rej;
    });
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) return null;
    try { sessionStorage.setItem(key, JSON.stringify(entry.data)); } catch (_) {}
    return entry.data;
  } catch (_) { return null; }
}

function cacheSet(key, data) {
  try { sessionStorage.setItem(key, JSON.stringify(data)); } catch (_) {}
  openCacheDB().then(idb => {
    const tx = idb.transaction('cache', 'readwrite');
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

// ─────────────────────────────────────────────────────────────────
// TCG API
// ─────────────────────────────────────────────────────────────────

async function fetchAllSets() {
  if (allSets) return allSets;
  try {
    const res = await fetch('./data/sets.json');
    if (res.ok) { allSets = await res.json(); return allSets; }
  } catch (_) {}
  const data = await tcgFetch(`${TCG_API}/sets?pageSize=250&orderBy=releaseDate&select=id,name,series,releaseDate,total,images`);
  allSets = data.data || [];
  return allSets;
}

async function fetchSetCards(setId) {
  const key = `cards_${setId}`;
  const hit = await cacheGet(key);
  if (hit) return hit;
  try {
    const res = await fetch(`./data/cards/${encodeURIComponent(setId)}.json`);
    if (res.ok) {
      const cards = await res.json();
      await cacheSet(key, cards);
      return cards;
    }
  } catch (_) {}
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

async function searchCards(queryStr) {
  const key = `search_v3_${queryStr.toLowerCase().replace(/\W+/g, '_')}`;
  const hit = await cacheGet(key);
  if (hit) return hit;
  const data = await tcgFetch(
    `${TCG_API}/cards?q=${encodeURIComponent(queryStr)}&pageSize=50&orderBy=set.releaseDate` +
    `&select=id,name,number,set,images,tcgplayer`
  );
  const cards = data.data || [];
  await cacheSet(key, cards);
  return cards;
}

// ─────────────────────────────────────────────────────────────────
// CARD TILE
// ─────────────────────────────────────────────────────────────────

function cardTile(card, { readonly = false, showSet = false, selectable = false, collectionOverride = null } = {}) {
  cardDataMap[card.id] = card;
  const coll   = collectionOverride || collection;
  const owned  = !!coll[card.id];
  const imgSrc = card.images?.small || '';
  const price  = bestPrice(card.tcgplayer?.prices);
  const sel    = selectable && selectedCards.has(card.id);
  const img    = imgSrc
    ? `<img class="card-img" src="${esc(imgSrc)}" alt="${esc(card.name)}" loading="lazy">`
    : `<div class="no-img">No image</div>`;

  const clickAction = selectable || (!readonly && !isGuest)
    ? `toggleCardSelect('${esc(card.id)}')`
    : `openModal('${esc(card.id)}')`;

  const overlayText = sel ? 'Selected' : (owned ? '' : (selectable || (!readonly && !isGuest) ? 'Select' : 'View details'));

  return `<div class="card-tile${owned ? ' owned' : ''}${sel ? ' selected' : ''}" data-id="${esc(card.id)}" data-name="${esc(card.name.toLowerCase())}">
  ${owned ? '<div class="owned-badge">Owned</div>' : ''}
  <div class="card-img-wrap" onclick="${clickAction}">
    ${img}<div class="card-overlay">${overlayText}</div>
  </div>
  <span class="card-name">${esc(card.name)}</span>
  <span class="card-num">${esc(card.number)}</span>
  ${price ? `<span class="card-price">~${fmt$(price)}</span>` : ''}
  ${showSet ? `<span class="card-set-badge">${esc(card.set?.name || '')}</span>` : ''}
</div>`;
}

// ─────────────────────────────────────────────────────────────────
// MULTI-SELECT
// ─────────────────────────────────────────────────────────────────

function enterSelectMode(listId, context) {
  selectMode = true;
  addingToList = listId || null;
  selectionContext = context || 'search';
  selectedCards.clear();
  selectedSets.clear();
  updateActionBar();
}

function exitSelectMode() {
  selectMode = false;
  addingToList = null;
  selectedCards.clear();
  selectedSets.clear();
  updateActionBar();
  document.querySelectorAll('.card-tile.selected').forEach(t => t.classList.remove('selected'));
}

window.toggleCardSelect = function(cardId) {
  if (!selectMode) {
    if (isGuest) { openModal(cardId); return; }
    const ctx = viewingCollection ? 'collection' : (viewingListId ? 'list' : 'search');
    enterSelectMode(ctx === 'list' ? viewingListId : null, ctx);
  }
  if (selectedCards.has(cardId)) {
    selectedCards.delete(cardId);
    document.querySelectorAll(`.card-tile[data-id="${CSS.escape(cardId)}"]`).forEach(t => t.classList.remove('selected'));
  } else {
    selectedCards.add(cardId);
    document.querySelectorAll(`.card-tile[data-id="${CSS.escape(cardId)}"]`).forEach(t => t.classList.add('selected'));
  }
  if (!selectedCards.size && !selectedSets.size) exitSelectMode();
  else updateActionBar();
};

window.selectAllInList = function() {
  if (!viewingListId) return;
  enterSelectMode(viewingListId, 'list');
  document.querySelectorAll('#lists-content .card-tile').forEach(tile => {
    const id = tile.dataset.id;
    if (id && !selectedCards.has(id)) {
      selectedCards.add(id);
      tile.classList.add('selected');
    }
  });
  updateActionBar();
};

window.selectAllVisible = function() {
  if (!selectMode) enterSelectMode(null);
  document.querySelectorAll('#search-results .card-tile').forEach(tile => {
    const id = tile.dataset.id;
    if (id && !selectedCards.has(id)) {
      selectedCards.add(id);
      tile.classList.add('selected');
    }
  });
  updateActionBar();
};

window.selectEntireSet = function(setId) {
  if (!selectMode) enterSelectMode(null);
  selectedSets.add(setId);
  updateActionBar();
  showToast('Entire set selected');
};

function updateActionBar() {
  const bar = document.getElementById('action-bar');
  if (!bar) return;
  if (!selectMode || (!selectedCards.size && !selectedSets.size)) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  document.getElementById('action-bar-count').textContent =
    `${selectedCards.size} card${selectedCards.size !== 1 ? 's' : ''}${selectedSets.size ? ` + ${selectedSets.size} set${selectedSets.size !== 1 ? 's' : ''}` : ''} selected`;

  const btns = document.getElementById('action-bar-buttons');
  if (selectionContext === 'collection') {
    btns.innerHTML = `<button class="action-bar-unowned" onclick="markSelectedNotOwned()">Mark Not Owned</button>
  <button class="action-bar-cancel" onclick="cancelSelection()">Cancel</button>`;
  } else if (selectionContext === 'list') {
    btns.innerHTML = `<button class="action-bar-owned" onclick="markSelectedOwned()">Mark Owned</button>
  <button class="action-bar-unowned" onclick="markSelectedNotOwned()">Mark Not Owned</button>
  <button class="action-bar-remove" onclick="removeSelectedFromList()">Remove from List</button>
  <button class="action-bar-cancel" onclick="cancelSelection()">Cancel</button>`;
  } else {
    btns.innerHTML = `<button class="action-bar-add" id="action-bar-add-btn" onclick="showActionListPicker()">Add to list ▾</button>
  <button class="action-bar-cancel" onclick="cancelSelection()">Cancel</button>`;
  }
}

window.commitSelection = async function(listId) {
  if (!listId) {
    const name = prompt('New list name:');
    if (!name) return;
    listId = await createList(name.trim());
    if (!listId) return;
  }

  const cards = [...selectedCards].map(id => cardDataMap[id]).filter(Boolean);
  const sets = [...selectedSets];
  await addItemsToList(listId, cards, sets);

  const lists = getLists();
  const listName = lists[listId]?.name || 'list';
  showToast(`Added to ${listName}`);
  exitSelectMode();
};

window.cancelSelection = function() { exitSelectMode(); };

window.markSelectedOwned = async function() {
  if (!currentUser) return;
  const ref = doc(db, 'collections', currentUser.uid);
  const delta = { updatedAt: serverTimestamp() };
  for (const cardId of selectedCards) {
    collection[cardId] = true;
    delta[cardId] = true;
  }
  await updateDoc(ref, delta).catch(async e => {
    if (e.code === 'not-found') await setDoc(ref, delta);
    else throw e;
  });
  selectedCards.forEach(id => syncTiles(id, true));
  showToast(`Marked ${selectedCards.size} card${selectedCards.size !== 1 ? 's' : ''} as owned`);
  exitSelectMode();
  if (viewingListId) openList(viewingListId);
};

window.markSelectedNotOwned = async function() {
  if (!currentUser) return;
  const ref = doc(db, 'collections', currentUser.uid);
  const delta = { updatedAt: serverTimestamp() };
  for (const cardId of selectedCards) {
    delete collection[cardId];
    delta[cardId] = deleteField();
  }
  await updateDoc(ref, delta).catch(() => {});
  selectedCards.forEach(id => syncTiles(id, false));
  const count = selectedCards.size;
  const wasCollection = viewingCollection;
  const wasListId = viewingListId;
  showToast(`Unmarked ${count} card${count !== 1 ? 's' : ''}`);
  exitSelectMode();
  if (wasCollection) openCollection();
  else if (wasListId) openList(wasListId);
};

window.removeSelectedFromList = async function() {
  if (!currentUser || !viewingListId) return;
  const ref = doc(db, 'wantlists', currentUser.uid);
  const updates = {};
  const items = getListItems(viewingListId);

  for (const cardId of selectedCards) {
    const match = items.find(i => i.type === 'card' && i.cardId === cardId);
    if (match) updates[match.itemId] = deleteField();
  }

  if (Object.keys(updates).length) {
    await updateDoc(ref, updates);
    showToast(`Removed ${Object.keys(updates).length} card${Object.keys(updates).length !== 1 ? 's' : ''} from list`);
  }
  exitSelectMode();
  openList(viewingListId);
};

window.showActionListPicker = function() {
  const picker = document.getElementById('action-list-picker');
  if (!picker.classList.contains('hidden')) { picker.classList.add('hidden'); return; }

  if (addingToList) {
    commitSelection(addingToList);
    return;
  }

  const lists = getLists();
  const listArr = Object.entries(lists).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));

  picker.innerHTML = listArr.map(([lid, info]) =>
    `<div class="action-list-picker-item" onclick="commitSelection('${esc(lid)}')">${esc(info.name)}</div>`
  ).join('') +
    `<div class="action-list-picker-item action-list-picker-create" onclick="commitSelection(null)">+ New list…</div>`;

  picker.classList.remove('hidden');
  const btn = document.getElementById('action-bar-add-btn');
  const rect = btn.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
  picker.style.right = (window.innerWidth - rect.right) + 'px';
};

document.addEventListener('click', e => {
  const picker = document.getElementById('action-list-picker');
  if (picker && !e.target.closest('#action-list-picker') && !e.target.closest('#action-bar-add-btn')) {
    picker.classList.add('hidden');
  }
});

// ─────────────────────────────────────────────────────────────────
// SEARCH TAB — composable filter system
// ─────────────────────────────────────────────────────────────────

const FILTER_TYPES = {
  name: { label: 'Name', buildQuery: v => `name:*${v}*` },
  set:  { label: 'Set',  buildQuery: v => `set.id:${v}` },
};

function buildSearchQuery() {
  return activeFilters.map(f => FILTER_TYPES[f.type].buildQuery(f.value)).join(' ');
}

function renderFilterChips() {
  const container = document.getElementById('active-filters');
  if (!container) return;
  container.innerHTML = activeFilters.map((f, i) =>
    `<span class="filter-chip">${esc(FILTER_TYPES[f.type].label)}: ${esc(f.label || f.value)}
      <button onclick="removeFilter(${i})">×</button>
    </span>`
  ).join('');
}

window.removeFilter = function(index) {
  activeFilters.splice(index, 1);
  renderFilterChips();
  runFilteredSearch();
};

window.addNameFilter = function() {
  const input = document.getElementById('search-input');
  const val = input?.value?.trim();
  if (!val || val.length < 2) return;
  activeFilters = activeFilters.filter(f => f.type !== 'name');
  activeFilters.push({ type: 'name', value: val, label: val });
  renderFilterChips();
  runFilteredSearch();
};

window.addSetFilter = function(setId, setName) {
  activeFilters = activeFilters.filter(f => f.type !== 'set');
  activeFilters.push({ type: 'set', value: setId, label: setName });
  renderFilterChips();
  document.getElementById('set-browser').classList.add('hidden');
  runFilteredSearch();
};

window.showSetBrowser = function() {
  const browser = document.getElementById('set-browser');
  browser.classList.toggle('hidden');
  if (!browser.classList.contains('hidden') && !browser.dataset.loaded) {
    browser.innerHTML = '<div class="loading"><div class="spinner"></div>Loading sets…</div>';
    renderSetBrowser();
  }
};

async function renderSetBrowser() {
  const browser = document.getElementById('set-browser');
  const sets = await fetchAllSets();
  browser.dataset.loaded = 'true';

  const byEra = {};
  for (const s of sets) (byEra[s.series] = byEra[s.series] || []).push(s);

  browser.innerHTML = `<input class="set-filter-input" id="set-filter-input" type="search"
    placeholder="Filter sets…" oninput="filterSetBrowser(this.value)">` +
    Object.entries(byEra).map(([era, list]) =>
      `<div class="era-section" data-era="${esc(era)}">
  <div class="era-header" onclick="this.parentElement.classList.toggle('collapsed')">
    <span class="toggle-icon">▾</span> ${esc(era)} <span class="era-count">(${list.length})</span>
  </div>
  <div class="era-sets">
    ${list.map(s => `<div class="set-row" data-set-name="${esc(s.name.toLowerCase())}">
  <span class="set-row-name" onclick="addSetFilter('${esc(s.id)}','${esc(s.name)}')">${esc(s.name)}</span>
  <span class="set-row-count">${s.total} cards</span>
  ${!isGuest ? `<button class="set-select-all-btn" onclick="selectEntireSet('${esc(s.id)}')">Select All</button>` : ''}
</div>`).join('')}
  </div>
</div>`).join('');
}

window.filterSetBrowser = function(query) {
  const q = query.toLowerCase();
  document.querySelectorAll('#set-browser .set-row').forEach(row => {
    row.classList.toggle('hidden', q && !row.dataset.setName.includes(q));
  });
  document.querySelectorAll('#set-browser .era-section').forEach(section => {
    const visible = section.querySelectorAll('.set-row:not(.hidden)').length;
    section.classList.toggle('hidden', q && !visible);
  });
};

document.getElementById('search-input')?.addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) {
    document.getElementById('search-hint').textContent = 'Type at least 2 characters';
    return;
  }
  document.getElementById('search-hint').textContent = 'Searching…';
  searchTimer = setTimeout(() => {
    activeFilters = activeFilters.filter(f => f.type !== 'name');
    activeFilters.push({ type: 'name', value: q, label: q });
    renderFilterChips();
    runFilteredSearch();
  }, 400);
});

async function runFilteredSearch() {
  const seq = ++searchSeq;
  const el = document.getElementById('search-results');
  const queryStr = buildSearchQuery();

  if (!queryStr) {
    el.innerHTML = `<div class="search-empty"><h3>Search cards</h3><p>Type a name or pick a set to search.</p></div>`;
    document.getElementById('search-hint').textContent = '';
    return;
  }

  el.innerHTML = '<div class="loading" style="grid-column:1/-1"><div class="spinner"></div>Searching…</div>';

  try {
    let cards;
    const setFilter = activeFilters.find(f => f.type === 'set');
    if (setFilter && activeFilters.length === 1) {
      cards = await fetchSetCards(setFilter.value);
    } else {
      cards = await searchCards(queryStr);
    }
    if (seq !== searchSeq) return;

    document.getElementById('search-hint').textContent = `${cards.length} result${cards.length !== 1 ? 's' : ''}`;

    if (!cards.length) {
      el.innerHTML = `<div class="search-empty"><h3>No results</h3><p>Try a different search.</p></div>`;
      return;
    }

    const selectable = !isGuest;
    const selectAllBtn = selectable ? `<div style="grid-column:1/-1;padding:2px 0 6px">
  <button class="select-all-btn" onclick="selectAllVisible()">Select all ${cards.length} cards</button>
</div>` : '';

    el.innerHTML = selectAllBtn + cards.map(c => cardTile(c, { showSet: true, selectable })).join('');
  } catch (e) {
    if (seq !== searchSeq) return;
    document.getElementById('search-hint').textContent = 'Search failed';
    el.innerHTML = `<div class="search-empty"><h3>Error</h3><p>${esc(e.message)}</p></div>`;
  }
}

// ─────────────────────────────────────────────────────────────────
// MY LISTS TAB
// ─────────────────────────────────────────────────────────────────

window.renderLists = async function renderLists() {
  viewingListId = null;
  viewingCollection = false;
  const el = document.getElementById('lists-content');
  const lists = getLists();
  const listArr = Object.entries(lists).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));

  const ownedCount = Object.keys(collection).length;

  const itemCounts = {};
  for (const [k, v] of Object.entries(wantlists)) {
    if (k.startsWith('_')) continue;
    itemCounts[v.list] = (itemCounts[v.list] || 0) + 1;
  }

  let html = '<div class="list-cards-grid">';
  html += `<div class="list-card list-card-collection" onclick="openCollection()">
  <div class="list-card-name">My Collection</div>
  <div class="list-card-count">${ownedCount} card${ownedCount !== 1 ? 's' : ''} owned</div>
</div>`;

  if (!listArr.length) {
    html += '</div>';
    el.innerHTML = html + `<div class="wantlist-empty" style="padding-top:20px">
      <p>No wishlists yet. Click <strong>"+ New List"</strong> to create one.</p>
    </div>`;
    return;
  }
  if (listArr.length > 1) {
    const totalItems = Object.values(itemCounts).reduce((a, b) => a + b, 0);
    html += `<div class="list-card" onclick="openList('__all__')">
  <div class="list-card-name">All</div>
  <div class="list-card-count">${totalItems} item${totalItems !== 1 ? 's' : ''}</div>
</div>`;
  }
  for (const [listId, listInfo] of listArr) {
    const count = itemCounts[listId] || 0;
    html += `<div class="list-card" onclick="openList('${esc(listId)}')">
  <div class="list-card-name">${esc(listInfo.name)}</div>
  <div class="list-card-count">${count} item${count !== 1 ? 's' : ''}</div>
  <button class="list-card-menu" onclick="event.stopPropagation();toggleListMenu('${esc(listId)}')" title="Options">⋯</button>
  <div class="list-menu hidden" id="menu-${esc(listId)}">
    <button onclick="renameList('${esc(listId)}')">Rename</button>
    <button onclick="shareList('${esc(listId)}')">Share link</button>
    <button onclick="deleteList('${esc(listId)}')">Delete</button>
  </div>
</div>`;
  }
  html += '</div>';
  el.innerHTML = html;
}

window.openList = async function(listId) {
  viewingListId = listId === '__all__' ? null : listId;
  document.querySelector('.tab-bar')?.classList.remove('hidden');
  const el = document.getElementById('lists-content');
  const lists = getLists();
  const isAll = listId === '__all__';
  const name = isAll ? 'All Lists' : (lists[listId]?.name || 'List');

  el.innerHTML = `<div class="list-detail-header">
  <button class="back-btn" onclick="renderLists()">← Back</button>
  <span class="list-detail-name">${esc(name)}</span>
  ${!isAll ? `<button class="add-cards-btn" onclick="addCardsToList('${esc(listId)}')">+ Add cards</button>` : ''}
</div>
<div class="loading"><div class="spinner"></div>Loading cards…</div>`;

  let cards = [];
  try {
    if (isAll) {
      const allListIds = Object.keys(lists);
      const allCards = [];
      for (const lid of allListIds) {
        const c = await resolveListCards(lid);
        allCards.push(...c);
      }
      const seen = new Set();
      cards = allCards.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });
    } else {
      cards = await resolveListCards(listId);
    }
  } catch (_) {}

  const nOwned = cards.filter(c => collection[c.id]).length;
  const tiles = cards.map(c => cardTile(c, { showSet: true })).join('');

  const menuBtns = isAll ? '' : `<button class="add-cards-btn" onclick="addCardsToList('${esc(listId)}')">+ Add cards</button>
  <button class="list-action-btn" onclick="selectAllInList()">Select All</button>
  <button class="list-action-btn" onclick="renameList('${esc(listId)}')">Rename</button>
  <button class="list-action-btn" onclick="shareList('${esc(listId)}')">Share</button>
  <button class="list-action-btn list-action-delete" onclick="deleteList('${esc(listId)}')">Delete</button>`;

  el.innerHTML = `<div class="list-detail-header">
  <button class="back-btn" onclick="renderLists()">← Back</button>
  <span class="list-detail-name">${esc(name)}</span>
  <span class="list-progress" style="color:#888">${nOwned} / ${cards.length} owned</span>
  ${menuBtns}
</div>
<div class="card-filter-bar">
  <button class="card-filter-btn active" onclick="applyCardFilter('all', this)">All</button>
  <button class="card-filter-btn" onclick="applyCardFilter('missing', this)">Missing Only</button>
  <button class="card-filter-btn" onclick="applyCardFilter('owned', this)">Owned Only</button>
</div>
<div class="card-grid" id="filtered-card-grid">${tiles || '<p class="list-empty">No cards in this list yet.</p>'}</div>`;
};

window.openCollection = async function() {
  viewingListId = null;
  viewingCollection = true;
  document.querySelector('.tab-bar')?.classList.remove('hidden');
  const el = document.getElementById('lists-content');
  const ownedIds = Object.keys(collection);

  if (!ownedIds.length) {
    el.innerHTML = `<div class="list-detail-header">
  <button class="back-btn" onclick="renderLists()">← Back</button>
  <span class="list-detail-name">My Collection</span>
</div>
<div class="wantlist-empty"><p>No cards owned yet. Browse sets and mark cards as owned.</p></div>`;
    return;
  }

  el.innerHTML = `<div class="list-detail-header">
  <button class="back-btn" onclick="renderLists()">← Back</button>
  <span class="list-detail-name">My Collection</span>
  <span class="list-progress" style="color:#888">${ownedIds.length} card${ownedIds.length !== 1 ? 's' : ''}</span>
</div>
<div class="loading"><div class="spinner"></div>Loading collection…</div>`;

  // Group owned card IDs by set
  const bySet = {};
  for (const cardId of ownedIds) {
    const parts = cardId.match(/^(.+)-\d+$/);
    const setId = parts ? parts[1] : cardId;
    (bySet[setId] = bySet[setId] || []).push(cardId);
  }

  // Fetch sets metadata for ordering
  const sets = await fetchAllSets();
  const setMeta = Object.fromEntries(sets.map(s => [s.id, s]));
  const sortedSetIds = Object.keys(bySet).sort((a, b) =>
    (setMeta[a]?.releaseDate || '').localeCompare(setMeta[b]?.releaseDate || '')
  );

  let html = `<div class="list-detail-header">
  <button class="back-btn" onclick="renderLists()">← Back</button>
  <span class="list-detail-name">My Collection</span>
  <span class="list-progress" style="color:#888">${ownedIds.length} card${ownedIds.length !== 1 ? 's' : ''}</span>
  <button class="list-action-btn" onclick="viewAllMissing()">View All Missing</button>
</div>
<div class="card-filter-bar">
  <button class="card-filter-btn active" onclick="setCollectionFilter('owned', this)">Owned Only</button>
  <button class="card-filter-btn" onclick="setCollectionFilter('all', this)">Full Sets</button>
  <button class="card-filter-btn" onclick="setCollectionFilter('missing', this)">Missing Only</button>
</div>`;

  for (const setId of sortedSetIds) {
    const setName = setMeta[setId]?.name || setId;
    const cardIds = bySet[setId];
    html += `<div class="list-section collapsed" data-collection-set="${esc(setId)}">
  <div class="list-header" onclick="toggleCollectionSet(this, '${esc(setId)}')">
    <div class="list-header-left">
      <span class="toggle-icon">▾</span>
      <span class="list-name">${esc(setName)}</span>
    </div>
    <span class="list-progress">${cardIds.length} owned</span>
  </div>
  <div class="list-body">
    <div class="card-grid" id="collection-set-${esc(setId)}">
      <div class="loading" style="grid-column:1/-1"><div class="spinner"></div></div>
    </div>
  </div>
</div>`;
  }

  el.innerHTML = html;
};

let collectionFilterMode = 'owned';

window.setCollectionFilter = function(mode, btn) {
  collectionFilterMode = mode;
  document.querySelectorAll('.card-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  // Reset loaded state so sets re-render with new filter
  document.querySelectorAll('[data-collection-set]').forEach(section => {
    const grid = section.querySelector('.card-grid');
    if (grid) { grid.dataset.loaded = ''; grid.innerHTML = '<div class="loading" style="grid-column:1/-1"><div class="spinner"></div></div>'; }
    if (!section.classList.contains('collapsed')) {
      const setId = section.dataset.collectionSet;
      toggleCollectionSet(section.querySelector('.list-header'), setId);
    }
  });
};

window.viewAllMissing = async function() {
  const el = document.getElementById('lists-content');
  const ownedIds = Object.keys(collection);

  // Find all sets the user owns cards from
  const bySet = {};
  for (const cardId of ownedIds) {
    const parts = cardId.match(/^(.+)-\d+$/);
    const setId = parts ? parts[1] : cardId;
    bySet[setId] = true;
  }
  const setIds = Object.keys(bySet);

  if (!setIds.length) {
    el.innerHTML = `<div class="list-detail-header">
  <button class="back-btn" onclick="openCollection()">← Back to Collection</button>
  <span class="list-detail-name">All Missing Cards</span>
</div>
<div class="wantlist-empty"><p>No sets in your collection yet.</p></div>`;
    return;
  }

  const sets = await fetchAllSets();
  const setMeta = Object.fromEntries(sets.map(s => [s.id, s]));
  const sortedSetIds = setIds.sort((a, b) =>
    (setMeta[a]?.releaseDate || '').localeCompare(setMeta[b]?.releaseDate || '')
  );

  el.innerHTML = `<div class="list-detail-header">
  <button class="back-btn" onclick="openCollection()">← Back to Collection</button>
  <span class="list-detail-name">All Missing Cards</span>
</div>
<div class="loading"><div class="spinner"></div>Loading missing cards across ${setIds.length} sets…</div>`;

  let totalMissing = 0;
  let html = `<div class="list-detail-header">
  <button class="back-btn" onclick="openCollection()">← Back to Collection</button>
  <span class="list-detail-name">All Missing Cards</span>
  <span class="list-progress" id="missing-total" style="color:#888">Loading…</span>
</div>`;

  for (const setId of sortedSetIds) {
    const cards = await fetchSetCards(setId);
    const missing = cards.filter(c => !collection[c.id]);
    if (!missing.length) continue;
    totalMissing += missing.length;
    const setName = setMeta[setId]?.name || setId;
    const tiles = missing.map(c => cardTile(c, { showSet: false })).join('');
    html += `<div class="list-section" data-collection-set="${esc(setId)}">
  <div class="list-header" onclick="this.parentElement.classList.toggle('collapsed')">
    <div class="list-header-left">
      <span class="toggle-icon">▾</span>
      <span class="list-name">${esc(setName)}</span>
    </div>
    <span class="list-progress">${missing.length} missing of ${cards.length}</span>
  </div>
  <div class="list-body">
    <div class="card-grid">${tiles}</div>
  </div>
</div>`;
  }

  el.innerHTML = html;
  const totalEl = document.getElementById('missing-total');
  if (totalEl) totalEl.textContent = `${totalMissing} cards missing`;
};

window.toggleCollectionSet = async function(header, setId) {
  const section = header.closest('.list-section');
  section.classList.toggle('collapsed');

  const grid = document.getElementById(`collection-set-${setId}`);
  if (!section.classList.contains('collapsed') && grid && !grid.dataset.loaded) {
    grid.dataset.loaded = 'true';
    const allCards = await fetchSetCards(setId);
    let cards;
    if (collectionFilterMode === 'owned') cards = allCards.filter(c => collection[c.id]);
    else if (collectionFilterMode === 'missing') cards = allCards.filter(c => !collection[c.id]);
    else cards = allCards;
    cards.sort((a, b) => (parseInt(a.number) || 0) - (parseInt(b.number) || 0));
    grid.innerHTML = cards.map(c => cardTile(c, { showSet: false })).join('') || '<p class="list-empty">No cards match this filter.</p>';
  }
};

let activeCardFilter = 'all';

window.applyCardFilter = function(mode, btn) {
  activeCardFilter = mode;
  document.querySelectorAll('.card-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  // Find all visible card grids and apply filter
  document.querySelectorAll('.tab-panel:not(.hidden) .card-tile, #profile-view:not(.hidden) .card-tile').forEach(tile => {
    const owned = tile.classList.contains('owned');
    if (mode === 'owned') tile.style.display = owned ? '' : 'none';
    else if (mode === 'missing') tile.style.display = owned ? 'none' : '';
    else tile.style.display = '';
  });
};

window.promptNewList = async function() {
  const name = prompt('New list name:');
  if (!name) return;
  const listId = await createList(name.trim());
  if (listId && confirm('Add cards now?')) {
    addCardsToList(listId);
  }
};

window.addCardsToList = function(listId) {
  enterSelectMode(listId);
  location.hash = '#/search';
};

// ─────────────────────────────────────────────────────────────────
// COMMUNITY TAB
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
      const isYou = currentUser && uid === currentUser.uid;
      const data = d.data();
      const name = userName(data);
      const photo = data.photoURL || '';
      const bio = data.bio || '';
      const av = photo
        ? `<img class="friend-avatar" src="${esc(photo)}" alt="${esc(name)}">`
        : `<div class="friend-no-photo"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg></div>`;
      html += `<div class="friend-card" onclick="location.hash='#/profile/${esc(uid)}'">
  ${av}
  <div class="friend-info"><h3>${esc(name)}${isYou ? ' <span style="font-size:.7rem;color:#aaa">(You)</span>' : ''}</h3>${bio ? `<p>${esc(bio)}</p>` : ''}</div>
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
  const cb = document.querySelector(`.card-tile[data-id="${CSS.escape(modalCardId)}"] input:not(:disabled)`);
  if (cb) {
    cb.checked = !cb.checked;
    window.handleToggle(cb, modalCardId);
  } else {
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
// PROFILE VIEW + ROUTING
// ─────────────────────────────────────────────────────────────────

const VALID_TABS = ['search', 'lists', 'community', 'settings'];

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
  document.querySelector('.tab-bar')?.classList.remove('hidden');
  renderProfile(uid, listId);
}

function hideProfileView() {
  document.getElementById('profile-view').classList.add('hidden');
}

async function renderProfile(uid, filterListId) {
  const headerEl = document.getElementById('profile-header');
  const listsEl = document.getElementById('profile-wishlists');
  headerEl.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  listsEl.innerHTML = '';

  const isOwn = currentUser && uid === currentUser.uid;

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
    const coll = { ...(cSnap.data() || {}) }; delete coll.updatedAt;
    const wlData = wSnap.data() || {};

    const name = userName(userData);
    const photo = userData.photoURL || '';
    const bio = userData.bio || '';
    const cardsOwned = Object.keys(coll).length;

    const avatarHtml = photo
      ? `<img class="profile-avatar" src="${esc(photo)}" alt="${esc(name)}">`
      : `<div class="profile-no-photo"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg></div>`;

    headerEl.innerHTML = `
      ${avatarHtml}
      <div class="profile-name">${esc(name)}</div>
      ${bio ? `<div class="profile-bio">${esc(bio)}</div>` : ''}
      <div class="profile-stats-row">
        <span>${cardsOwned} card${cardsOwned !== 1 ? 's' : ''} owned</span>
      </div>`;

    // Handle both v2 and v3 wantlist formats
    let lists, listArr;
    if (wlData._version === 3) {
      lists = wlData._lists || {};
      listArr = Object.entries(lists).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
    } else if (Object.keys(wlData).length) {
      // v2 format: Pokemon names as keys — show as a single "Wishlist"
      lists = { _legacy: { name: 'Wishlist', order: 0 } };
      listArr = [['_legacy', { name: 'Wishlist', order: 0 }]];
    } else {
      lists = {};
      listArr = [];
    }

    if (!listArr.length) {
      listsEl.innerHTML = '<div class="wantlist-empty"><p>No lists yet.</p></div>';
      return;
    }

    if (filterListId) {
      const match = listArr.find(([id]) => id === filterListId);
      if (!match) {
        listsEl.innerHTML = '<div class="wantlist-empty"><p>List not found.</p></div>';
        return;
      }
      listsEl.innerHTML = `<div class="list-detail-header">
  <button class="back-btn" onclick="location.hash='#/profile/${esc(uid)}'">← Back</button>
  <span class="list-detail-name">${esc(match[1].name)}</span>
  <span class="list-progress" id="profile-list-progress" style="color:#888">Loading…</span>
</div>
<div class="card-filter-bar">
  <button class="card-filter-btn active" onclick="applyCardFilter('all', this)">All</button>
  <button class="card-filter-btn" onclick="applyCardFilter('missing', this)">Missing Only</button>
  <button class="card-filter-btn" onclick="applyCardFilter('owned', this)">Owned Only</button>
</div>
<div class="card-grid" id="profile-list-cards" data-filterable="true">
  <div class="loading" style="grid-column:1/-1"><div class="spinner"></div></div>
</div>`;
      loadProfileListCards(filterListId, wlData, coll);
      return;
    }

    // Show list cards (compact, click to open)
    const itemCounts = {};
    for (const [k, v] of Object.entries(wlData)) {
      if (k.startsWith('_')) continue;
      itemCounts[v.list] = (itemCounts[v.list] || 0) + 1;
    }

    let html = '<div class="list-cards-grid">';
    html += `<div class="list-card list-card-missing" onclick="viewProfileMissing('${esc(uid)}')">
  <div class="list-card-name">All Missing</div>
  <div class="list-card-count">Across all lists</div>
</div>`;
    for (const [listId, listInfo] of listArr) {
      const count = itemCounts[listId] || 0;
      html += `<div class="list-card" onclick="location.hash='#/profile/${esc(uid)}/${esc(listId)}'">
  <div class="list-card-name">${esc(listInfo.name)}</div>
  <div class="list-card-count">${count} item${count !== 1 ? 's' : ''}</div>
</div>`;
    }
    html += '</div>';
    listsEl.innerHTML = html;

  } catch (e) {
    console.error('[Porydex] Profile load error:', e);
    headerEl.innerHTML = `<div class="loading">Failed to load profile: ${esc(e.message)}</div>`;
  }
}

window.viewProfileMissing = async function(uid) {
  const listsEl = document.getElementById('profile-wishlists');
  listsEl.innerHTML = '<div class="loading"><div class="spinner"></div>Loading missing cards…</div>';

  try {
    const [cSnap, wSnap] = await Promise.all([
      getDoc(doc(db, 'collections', uid)),
      getDoc(doc(db, 'wantlists', uid)),
    ]);
    const coll = { ...(cSnap.data() || {}) }; delete coll.updatedAt;
    const wlData = wSnap.data() || {};

    let lists, listArr;
    if (wlData._version === 3) {
      lists = wlData._lists || {};
      listArr = Object.entries(lists).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
    } else if (Object.keys(wlData).length) {
      lists = { _legacy: { name: 'Wishlist', order: 0 } };
      listArr = [['_legacy', { name: 'Wishlist', order: 0 }]];
    } else {
      listsEl.innerHTML = '<div class="wantlist-empty"><p>No lists to show.</p></div>';
      return;
    }

    let html = `<div class="list-detail-header">
  <button class="back-btn" onclick="location.hash='#/profile/${esc(uid)}'">← Back</button>
  <span class="list-detail-name">All Missing Cards</span>
  <span class="list-progress" id="profile-missing-total" style="color:#888">Loading…</span>
</div>`;

    let totalMissing = 0;
    for (const [listId, listInfo] of listArr) {
      const isLegacy = listId === '_legacy';
      let allCards = [];

      if (isLegacy) {
        for (const [k, v] of Object.entries(wlData)) {
          if (k.startsWith('_')) continue;
          if (v.displayName) {
            try { allCards.push(...await searchCards(`name:*${v.displayName}*`)); } catch (_) {}
          }
        }
      } else {
        const items = Object.entries(wlData).filter(([k, v]) => !k.startsWith('_') && v.list === listId);
        const setsNeeded = new Set();
        for (const [, item] of items) setsNeeded.add(item.setId);
        const setCardMap = {};
        for (const setId of setsNeeded) {
          try { setCardMap[setId] = await fetchSetCards(setId); } catch (_) { setCardMap[setId] = []; }
        }
        for (const [, item] of items) {
          const setCards = setCardMap[item.setId] || [];
          if (item.type === 'set') allCards.push(...setCards);
          else if (item.type === 'card') {
            const m = setCards.find(c => c.id === item.cardId);
            if (m) allCards.push(m);
          }
        }
      }

      const seen = new Set();
      allCards = allCards.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });
      const missing = allCards.filter(c => !coll[c.id]);
      if (!missing.length) continue;

      totalMissing += missing.length;
      missing.sort((a, b) => {
        const setCmp = (a.set?.releaseDate || '').localeCompare(b.set?.releaseDate || '');
        if (setCmp !== 0) return setCmp;
        return (parseInt(a.number) || 0) - (parseInt(b.number) || 0);
      });

      html += `<div class="list-section">
  <div class="list-header" onclick="this.parentElement.classList.toggle('collapsed')">
    <div class="list-header-left">
      <span class="toggle-icon">▾</span>
      <span class="list-name">${esc(listInfo.name)}</span>
    </div>
    <span class="list-progress">${missing.length} missing</span>
  </div>
  <div class="list-body">
    <div class="card-grid">${missing.map(c => cardTile(c, { readonly: true, showSet: true, collectionOverride: coll })).join('')}</div>
  </div>
</div>`;
    }

    listsEl.innerHTML = html;
    const totalEl = document.getElementById('profile-missing-total');
    if (totalEl) totalEl.textContent = `${totalMissing} card${totalMissing !== 1 ? 's' : ''} missing`;
    if (!totalMissing) listsEl.innerHTML += '<div class="wantlist-empty"><p>No missing cards — they have everything!</p></div>';
  } catch (e) {
    listsEl.innerHTML = `<div class="wantlist-empty"><p>Failed to load: ${esc(e.message)}</p></div>`;
  }
};

async function loadProfileListCards(listId, wlData, coll) {
  const gridEl = document.getElementById('profile-list-cards');
  const progEl = document.getElementById('profile-list-progress');
  if (!gridEl) return;

  try {
    // Handle v2 legacy format (Pokemon names) vs v3 (set/card items)
    const isLegacy = listId === '_legacy';
    let allCards = [];

    if (isLegacy) {
      const entries = Object.entries(wlData).filter(([k]) => !k.startsWith('_'));
      if (progEl) progEl.textContent = `Loading ${entries.length} Pokémon…`;
      for (const [, info] of entries) {
        if (info.displayName) {
          try {
            const cards = await searchCards(`name:*${info.displayName}*`);
            allCards.push(...cards);
          } catch (_) {}
        }
      }
    } else {
      const items = Object.entries(wlData)
        .filter(([k, v]) => !k.startsWith('_') && v.list === listId);

      if (!items.length) {
        gridEl.innerHTML = '<p class="list-empty">Empty list.</p>';
        if (progEl) progEl.textContent = '0 cards';
        return;
      }

      const setsNeeded = new Set();
      for (const [, item] of items) setsNeeded.add(item.setId);

      const setCardMap = {};
      if (progEl) progEl.textContent = `Loading ${setsNeeded.size} set${setsNeeded.size !== 1 ? 's' : ''}…`;
      for (const setId of setsNeeded) {
        try { setCardMap[setId] = await fetchSetCards(setId); }
        catch (e) { setCardMap[setId] = []; }
      }

      for (const [, item] of items) {
        const setCards = setCardMap[item.setId] || [];
        if (item.type === 'set') {
          allCards.push(...setCards);
        } else if (item.type === 'card') {
          const match = setCards.find(c => c.id === item.cardId);
          if (match) allCards.push(match);
        }
      }
    }

    const seen = new Set();
    allCards = allCards.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });
    allCards.sort((a, b) => {
      const setCmp = (a.set?.releaseDate || '').localeCompare(b.set?.releaseDate || '');
      if (setCmp !== 0) return setCmp;
      return (parseInt(a.number) || 0) - (parseInt(b.number) || 0);
    });

    const nOwned = allCards.filter(c => coll[c.id]).length;
    if (progEl) progEl.textContent = `${nOwned} / ${allCards.length} owned`;

    if (!allCards.length) {
      gridEl.innerHTML = '<p class="list-empty">No cards found.</p>';
      return;
    }

    gridEl.innerHTML = allCards.map(c => cardTile(c, { readonly: true, showSet: true, collectionOverride: coll })).join('');
  } catch (e) {
    console.error('[Porydex] List load error:', listId, e);
    gridEl.innerHTML = `<p class="list-empty">Failed to load cards: ${esc(e.message)}</p>`;
    if (progEl) progEl.textContent = 'Error';
  }
}

async function loadSettings() {
  if (!currentUser) return;
  const snap = await getDoc(doc(db, 'users', currentUser.uid));
  const data = snap.data() || {};
  document.getElementById('settings-name').value = data.customName || '';
  document.getElementById('settings-bio').value = data.bio || '';
  document.getElementById('settings-public-cb').checked = !!data.publicProfile;
  const photo = document.getElementById('settings-photo');
  if (currentUser.photoURL) { photo.src = currentUser.photoURL; photo.style.display = ''; }
  else photo.style.display = 'none';
}

window.saveSettings = async function() {
  if (!currentUser) return;
  const customName = document.getElementById('settings-name')?.value?.trim() || '';
  const bio = document.getElementById('settings-bio')?.value?.trim() || '';
  await setDoc(doc(db, 'users', currentUser.uid), { customName, bio }, { merge: true });
  document.getElementById('user-name').textContent = customName || currentUser.displayName || currentUser.email;
  showToast('Profile saved');
};

document.getElementById('back-from-profile').addEventListener('click', () => { location.hash = ''; });
document.getElementById('copy-profile-link').addEventListener('click', () => {
  navigator.clipboard.writeText(location.href).then(() => showToast('Link copied!'));
});

window.addEventListener('hashchange', handleRoute);

// ─────────────────────────────────────────────────────────────────
// TAB SWITCHING
// ─────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn =>
  btn.addEventListener('click', () => { location.hash = `#/${btn.dataset.tab}`; })
);

window.switchTab = async function switchTab(tab, fromRouter) {
  activeTab = tab;
  if (!fromRouter) location.hash = `#/${tab}`;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById(`tab-${tab}`).classList.remove('hidden');
  document.querySelector('.tab-bar')?.classList.remove('hidden');
  if (tab === 'lists') await renderLists();
  if (tab === 'community') await renderCommunity();
  if (tab === 'settings') await loadSettings();
  if (tab === 'search' && addingToList) {
    const lists = getLists();
    const name = lists[addingToList]?.name || 'list';
    showToast(`Adding to: ${name}. Select cards, then click "Add to list".`);
  }
};

// ─────────────────────────────────────────────────────────────────
// IMPORT — owned_cards.json (on profile page)
// ─────────────────────────────────────────────────────────────────

window.exportCollection = function() {
  if (!currentUser) return;
  const data = { ...collection };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `porydex-collection-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Collection exported');
};

window.exportLists = function() {
  if (!currentUser) return;
  const data = { ...wantlists };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `porydex-lists-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Lists exported');
};

document.getElementById('import-file-input')?.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file || !currentUser) return;
  try {
    const data = JSON.parse(await file.text());
    if (typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a JSON object');
    await setDoc(doc(db, 'collections', currentUser.uid), { ...data, updatedAt: serverTimestamp() }, { merge: true });
    alert(`Imported ${Object.keys(data).length} owned cards.`);
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
  e.target.value = '';
});
