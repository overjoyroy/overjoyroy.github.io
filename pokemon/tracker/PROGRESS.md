# Pokemon Tracker — Progress & Handoff

## What this is

A multi-user Pokemon card tracker replacing the old static `missing_cards.html`.
Built as a separate app at `/pokemon/tracker/` — the old checklist is **intentionally preserved**.

## What's done

### Files in this directory

| File | Status | Notes |
|---|---|---|
| `index.html` | ✅ Complete | App shell + all CSS. No generated content. |
| `app.js` | ✅ Complete | Full app logic — auth, Firestore, TCG API, all 4 tabs. |
| `firebase-config.js` | ⚠️ Template | Placeholder values — must be replaced with real Firebase config. |
| `firestore.rules` | ✅ Complete | Ready to paste into Firebase Console → Firestore → Rules. |

### Migration script (local only, not in this repo)

`/Users/joy/Documents/pokemon/export_owned.py`
- Reads `personal.xlsx`, queries Pokemon TCG API to map card numbers to API IDs
- Outputs `owned_cards.json` → `{ "base1-4": true, ... }`
- Run once: `conda run -n base python3 /Users/joy/Documents/pokemon/export_owned.py`
- Then import via the yellow banner in the app

## "Continue without signing in" setup

The landing page now has a "Continue without signing in" option for read-only browsing —
no Firebase Anonymous Auth needed. This requires Firestore reads to be public:

1. **Re-apply Firestore rules**: Firestore → Rules tab → paste the updated contents of `firestore.rules`
   (reads are now public; writes still require the signed-in owner, unchanged)

## What needs to happen before the app works

### Step 1 — Firebase project setup (~10 min, one-time)

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Create a new project (free Spark plan)
3. **Enable Google Sign-In**: Authentication → Sign-in method → Google → Enable
4. **Enable Firestore**: Firestore Database → Create database → Start in production mode
5. **Apply security rules**: Firestore → Rules tab → paste contents of `firestore.rules`
6. **Get config**: Project Settings → Your Apps → Add web app → copy the config object
7. **Fill in `firebase-config.js`**: replace all `REPLACE_WITH_...` values

### Step 2 — Push to GitHub

The branch `feature/pokemon-tracker` has the new files committed locally.
The GitHub push is currently blocked (previous PAT token was exposed in chat; must be revoked).

1. Revoke old token at [github.com/settings/tokens](https://github.com/settings/tokens)
2. Create new token: Settings → Developer settings → Personal access tokens → Classic → `repo` scope
3. Set remote URL and push:
```bash
cd /Users/joy/Desktop/Research/website/overjoyroy.github.io
git remote set-url origin https://<NEW_TOKEN>@github.com/overjoyroy/overjoyroy.github.io.git
git push -u origin feature/pokemon-tracker
```
4. Merge into `master` when ready to go live (PR or direct merge)

### Step 3 — Add friends

When a friend signs in for the first time, their UID appears in the browser console:
```
[Tracker] To add this user to FRIENDS, paste: { uid: '...', displayName: '...' }
```

Edit `app.js`:
1. Add friend's email to `ALLOWED_EMAILS` array
2. Add `{ uid: '...', displayName: '...' }` to `FRIENDS` array
3. Push updated `app.js` to GitHub

### Step 4 — Update personal.md link (optional)

`_pages/personal.md` currently links to `/pokemon/missing_cards.html`.
Add a second button linking to `/pokemon/tracker/` when ready to expose the new app.

---

## Architecture summary

**Frontend**: GitHub Pages (free static hosting) — `index.html` + `app.js`
**Backend**: Firebase Spark plan (free)
- Firebase Auth → Google Sign-In with email allowlist
- Firestore → per-user data (owned cards, tracked sets, want lists)

**Card data**: Live from [api.pokemontcg.io](https://api.pokemontcg.io) — CORS-enabled, free, no key needed
- Responses cached in `sessionStorage` (cleared on tab close)

**Firestore schema**:
```
users/{uid}         → { displayName, email, photoURL, trackedSets: [setId, ...] }
collections/{uid}   → { "base1-4": true, "basep-5": true, ..., updatedAt }
wantlists/{uid}     → { "dragonite": { displayName, addedAt }, ... }
```

## App features (all implemented)

| Feature | Tab | Notes |
|---|---|---|
| Google Sign-In with allowlist | — | Non-allowlisted accounts are signed out immediately |
| Per-user card collection | My Checklist | Synced to Firestore in real-time |
| Set picker | My Checklist | Choose from all TCG sets, grouped by era |
| Owned/missing tracking | My Checklist | Toggle updates Firestore; offline-tolerant |
| Card detail modal | everywhere | Image, prices by finish type, eBay link |
| Filter + missing-only toggle | My Checklist | Real-time name filter |
| Search all cards by Pokémon name | Search | Queries TCG API live; debounced 400ms |
| Track all [Pokémon] want list | Search | Stored in Firestore wantlists |
| Want list progress | Want Lists | Owned / total per species |
| Friends' collections (read-only) | Friends | Hardcoded UID list in app.js |
| Import from owned_cards.json | My Checklist | One-time migration from xlsx |
| Persistent login | — | Firebase Auth + IndexedDB offline persistence |

## Known gaps / future ideas

- `personal.md` still only links to old `missing_cards.html` — add a second link when ready
- `export_owned.py` may warn about unmatched xlsx sheet names; those sets just get skipped
- Friends tab requires manually adding UIDs to `app.js` — no self-service onboarding
- No trade view yet (Phase 4 from the plan) — was designed but not built
- Search results don't paginate (capped at 50 cards per query by API)

## Key files elsewhere

```
Documents/pokemon/
  export_owned.py         ← run to generate owned_cards.json (one-time)
  personal.xlsx           ← source of owned card data (archive after migration)
  missing_cards.py        ← old script (no longer needed)
  generate_checklist.py   ← old script (no longer needed)

overjoyroy.github.io/
  pokemon/missing_cards.html   ← old static app — keep, do not delete
  _pages/personal.md           ← links to old app; update when ready
  _data/navigation.yml         ← has "Personal" nav entry
```
