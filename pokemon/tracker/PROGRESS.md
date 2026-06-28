# Porydex — Progress & Handoff

## What this is

A multi-user Pokemon card collection tracker at `/pokemon/tracker/`.
Guest-friendly — anyone can browse, search, and view public profiles without signing in.
The old static `missing_cards.html` is **intentionally preserved** alongside this app.

## What's done

### Files in this directory

| File | Status | Notes |
|---|---|---|
| `index.html` | ✅ Complete | App shell, all CSS, welcome page, profile view |
| `app.js` | ✅ Complete | Full app logic — auth, Firestore, TCG API, routing |
| `firebase-config.js` | ✅ Configured | Live Firebase config for the Porydex project |
| `firestore.rules` | ✅ Complete | Public reads, owner-only writes — must be pasted into Firebase Console |
| `njoysporygon.png` | ✅ Asset | Welcome page mascot card (placeholder — Nurse Joy's Porygon) |

### Migration script (local only, not in this repo)

`/Users/joy/Documents/pokemon/export_owned.py`
- Reads `personal.xlsx`, queries Pokemon TCG API to map card numbers to API IDs
- Outputs `owned_cards.json` → `{ "base1-4": true, ... }`
- Run once: `conda run -n base python3 /Users/joy/Documents/pokemon/export_owned.py`
- Then import via the yellow banner in the app

## Firebase Console setup required

### Firestore rules (must be applied manually)

Paste the contents of `firestore.rules` into Firebase Console → Firestore → Rules tab.
Reads are public (guests can browse); writes require the signed-in document owner.

### Authorized domains

Firebase Console → Authentication → Settings → Authorized domains.
Ensure these are listed:
- `localhost` (default, for local dev)
- `joyroy.org` (production)
- Any other domain you serve from

## Architecture

**Frontend**: GitHub Pages — `index.html` + `app.js` (vanilla JS, no build tools)
**Backend**: Firebase Spark plan (free)
- Firebase Auth → Google Sign-In with email allowlist + redirect flow
- Firestore → per-user data (owned cards, tracked sets, wishlists)

**Card data**: Live from [api.pokemontcg.io](https://api.pokemontcg.io) — CORS-enabled, free, no key needed
- Responses cached in IndexedDB (7-day TTL) + sessionStorage (L1/L2 cache)

**Routing**: Hash-based (`#/search`, `#/community`, `#/profile/uid`, etc.)
- Browser back/forward works between all views
- Profile URLs are shareable

### Firestore schema

```
users/{uid}         → { displayName, email, photoURL, trackedSets: [...], publicProfile: bool }
collections/{uid}   → { "base1-4": true, "basep-5": true, ..., updatedAt }
wantlists/{uid}     → { _version: 2, _lists: { listId: { name, order } }, _defaultList: listId,
                         "dragonite": { displayName, addedAt, list: listId }, ... }
```

## App features

| Feature | View | Notes |
|---|---|---|
| Welcome page | Home | Mascot card, description, feature links |
| Guest browsing | all | No sign-in required; read-only access to Search + Community |
| Google Sign-In | topbar | Redirect-based; email allowlist in `ALLOWED_EMAILS` |
| Per-user card collection | My Checklist | Synced to Firestore in real-time |
| Set picker | Wishlists | Choose from all TCG sets, grouped by era |
| Owned/missing tracking | My Checklist | Optimistic toggle, offline-tolerant |
| Card detail modal | everywhere | Image, prices by finish type, eBay link |
| Filter + missing-only toggle | My Checklist | Real-time name filter |
| Search (wildcard substring) | Search | `name:*query*` via TCG API; debounced 400ms with race guard |
| Multiple named wishlists | Wishlists | Create, rename, delete, set default; per-list share links |
| List picker on "Track all" | Search | Choose which wishlist to add to (dropdown if multiple lists) |
| Auto-migration | — | Old flat wantlist format auto-upgrades to v2 multi-list |
| Public profiles | Community | Opt-in via "Public profile" toggle; listed in Community tab |
| Shareable profile pages | `#/profile/uid` | Read-only view of user's wishlists + stats; works for guests |
| Per-list share links | `#/profile/uid/listId` | Direct link to a specific wishlist |
| Community directory | Community | Shows all users with public profiles |
| Import from owned_cards.json | My Checklist | One-time migration from xlsx |
| Navigation links | topbar | "← joyroy" back to main site; "Porydex" logo to tracker home |

## Adding new users

1. Add their email to `ALLOWED_EMAILS` in `app.js`
2. Push updated `app.js` to GitHub
3. They sign in via the topbar button — their profile auto-creates in Firestore
4. They can toggle "Public profile" in the Community tab to appear in the directory

## Known gaps / future ideas

- Custom mascot card to replace the Nurse Joy placeholder
- Search results don't paginate (capped at 50 cards per query by API)
- No trade view yet
- Split into separate page files for better code organization
- Sign-in redirect doesn't work on localhost — use the deployed site for auth testing

## Key files elsewhere

```
Documents/pokemon/
  website/                  ← full site repo (moved here from Desktop)
  export_owned.py           ← run to generate owned_cards.json (one-time)
  personal.xlsx             ← source of owned card data
  missing_cards.py           ← generates missing_cards.csv from personal.xlsx
  generate_checklist.py     ← generates missing_cards.html from CSV

website/
  pokemon/missing_cards.html   ← old static checklist — keep, do not delete
  _pages/personal.md           ← links to old app + Porydex
  _data/navigation.yml         ← has "Personal" nav entry
```
