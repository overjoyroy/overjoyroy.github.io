#!/usr/bin/env python3
"""Refresh the static card catalog and market prices.

Catalog pages come from Scrydex because it covers new releases before the
deprecated PokemonTCG.io feed. Existing card prices are refreshed from the
keyless TCGdex API (TCGplayer USD with Cardmarket EUR as a fallback).

Usage:
  python3 update_catalog.py                 # catalog and all prices
  python3 update_catalog.py --catalog-only
  python3 update_catalog.py --prices-only
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from html import unescape
import json
import os
import re
import subprocess
import time

ROOT = os.path.dirname(__file__)
DATA = os.path.join(ROOT, "data")
CARDS = os.path.join(DATA, "cards")
SETS_FILE = os.path.join(DATA, "sets.json")
TCGDEX = "https://api.tcgdex.net/v2/en"

SCRYDEX_SETS = {
    "svp": ("Scarlet & Violet Black Star Promos", "Scarlet & Violet", "2023/03/31", "scarlet-violet-black-star-promos"),
    "sve": ("Scarlet & Violet Energies", "Scarlet & Violet", "2023/03/31", "scarlet-violet-energies"),
    "mep": ("Mega Evolution Black Star Promos", "Mega Evolution", "2025/09/26", "mega-evolution-black-star-promos"),
    "mee": ("Mega Evolution Energies", "Mega Evolution", "2025/09/26", "mega-evolution-energies"),
    "me5": ("Pitch Black", "Mega Evolution", "2026/07/17", "pitch-black"),
    "me55": ("30th Celebration", "Mega Evolution", "2026/09/16", "30th-celebration"),
    "me55c": ("Classic Collection", "Mega Evolution", "2026/09/16", "classic-collection"),
}

USER_AGENT = "Porydex catalog updater/2.0"


def get(url, *, json_response=False, retries=4):
    for attempt in range(retries):
        try:
            result = subprocess.run(
                ["curl", "-sS", "-L", "--fail", "--max-time", "35", "-A", USER_AGENT, url],
                check=True, capture_output=True,
            )
            body = result.stdout.decode("utf-8", "replace")
            return json.loads(body) if json_response else body
        except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
            if isinstance(exc, subprocess.CalledProcessError) and exc.returncode == 22:
                return None
            if attempt == retries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))


def write_json(path, value):
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(temp, path)


def parse_scrydex(html, set_info, set_id):
    name, series, release_date, _ = set_info
    set_data = {
        "id": set_id, "name": name, "series": series,
        "releaseDate": release_date,
        "images": {
            "symbol": f"https://images.scrydex.com/pokemon/{set_id}-symbol/symbol",
            "logo": f"https://images.scrydex.com/pokemon/{set_id}-logo/logo",
        },
    }
    # The page contains both grid and table views, hence de-duplication by ID.
    pattern = re.compile(
        r'<a[^>]+href="/pokemon/cards/[^"?]+/(?P<id>[^"?]+)\?variant=(?P<finish>[^"&]+)"[^>]*>'
        r'(?P<body>.*?)</a>', re.S
    )
    cards = {}
    finish_names = {"normal": "normal", "holofoil": "holofoil", "reverse-holofoil": "reverseHolofoil"}
    for match in pattern.finditer(html):
        label_match = re.search(r'<span[^>]*>([^<]+)\s+#([^<]+)</span>', match.group("body"))
        if not label_match:
            continue
        card_id = unescape(match.group("id"))
        card = cards.setdefault(card_id, {
            "id": card_id,
            "name": unescape(label_match.group(1)).strip(),
            "number": unescape(label_match.group(2)).strip(),
            "set": set_data,
            "images": {
                "small": f"https://images.scrydex.com/pokemon/{card_id}/small",
                "large": f"https://images.scrydex.com/pokemon/{card_id}/large",
            },
            "tcgplayer": {"prices": {}},
            "priceSource": "Scrydex market estimate",
        })
        price_match = re.search(r'\$[0-9,.]+', match.group("body"))
        raw_price = price_match.group(0) if price_match else None
        if raw_price:
            finish = finish_names.get(match.group("finish"), match.group("finish").replace("-", ""))
            card["tcgplayer"]["prices"][finish] = {"market": float(raw_price[1:].replace(",", ""))}
    return list(cards.values())


def refresh_scrydex_catalog():
    sets = json.load(open(SETS_FILE, encoding="utf-8"))
    by_id = {item["id"]: item for item in sets}
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for set_id, info in SCRYDEX_SETS.items():
        slug = info[3]
        print(f"Scrydex: {set_id} {info[0]}", flush=True)
        html = get(f"https://scrydex.com/pokemon/expansions/{slug}/{set_id}")
        cards = parse_scrydex(html, info, set_id)
        if not cards:
            raise RuntimeError(f"No cards parsed for {set_id}; page format may have changed")
        for card in cards:
            card["priceUpdatedAt"] = now
        write_json(os.path.join(CARDS, f"{set_id}.json"), cards)
        name, series, date, _ = info
        by_id[set_id] = {
            "id": set_id, "name": name, "series": series, "total": len(cards),
            "releaseDate": date,
            "images": {
                "symbol": f"https://images.scrydex.com/pokemon/{set_id}-symbol/symbol",
                "logo": f"https://images.scrydex.com/pokemon/{set_id}-logo/logo",
            },
        }
        print(f"  wrote {len(cards)} cards")
    custom = [item for item in sets if item.get("custom")]
    regular = [item for item in by_id.values() if not item.get("custom")]
    regular.sort(key=lambda item: (item.get("releaseDate", ""), item["id"]))
    write_json(SETS_FILE, regular + custom)


def normalized(value):
    return re.sub(r"[^a-z0-9]", "", str(value).lower()).lstrip("0") or "0"


def normalize_tcgplayer(pricing):
    result = {}
    names = {
        "reverse-holofoil": "reverseHolofoil", "1st-edition": "1stEdition",
        "1st-edition-holofoil": "1stEditionHolofoil", "unlimited-holofoil": "unlimitedHolofoil",
    }
    for finish, values in (pricing or {}).items():
        if not isinstance(values, dict):
            continue
        clean = {}
        for source, target in (("lowPrice", "low"), ("midPrice", "mid"),
                               ("highPrice", "high"), ("marketPrice", "market"),
                               ("directLowPrice", "directLow")):
            if values.get(source) is not None:
                clean[target] = values[source]
        if clean:
            result[names.get(finish, finish)] = clean
    return result


def fetch_full_card(card_id):
    return card_id, get(f"{TCGDEX}/cards/{card_id}", json_response=True)


def refresh_prices(workers=24):
    local_sets = json.load(open(SETS_FILE, encoding="utf-8"))
    remote_sets = get(f"{TCGDEX}/sets", json_response=True)
    remote_by_name = {normalized(item["name"]): item for item in remote_sets}
    jobs = []
    owners = {}
    loaded = {}
    for set_info in local_sets:
        if set_info.get("custom"):
            continue
        path = os.path.join(CARDS, f'{set_info["id"]}.json')
        if not os.path.exists(path):
            continue
        match = remote_by_name.get(normalized(set_info["name"]))
        if not match:
            continue
        detail = get(f'{TCGDEX}/sets/{match["id"]}', json_response=True)
        if not detail:
            continue
        remote_cards = {normalized(card.get("localId")): card["id"] for card in detail.get("cards", [])}
        cards = json.load(open(path, encoding="utf-8"))
        loaded[path] = cards
        for index, card in enumerate(cards):
            remote_id = remote_cards.get(normalized(card.get("number")))
            if remote_id:
                jobs.append(remote_id)
                owners[remote_id] = (path, index)
    print(f"TCGdex: refreshing {len(jobs)} matched cards", flush=True)
    updated = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(fetch_full_card, card_id) for card_id in jobs]
        for count, future in enumerate(as_completed(futures), 1):
            card_id, remote = future.result()
            if remote and remote.get("pricing"):
                path, index = owners[card_id]
                card = loaded[path][index]
                pricing = remote["pricing"]
                tcg = normalize_tcgplayer(pricing.get("tcgplayer"))
                if tcg:
                    card.setdefault("tcgplayer", {})["prices"] = tcg
                    card["tcgplayer"]["updatedAt"] = pricing.get("tcgplayer", {}).get("updated")
                    card.pop("priceSource", None)
                    card.pop("priceUpdatedAt", None)
                    updated += 1
                market = pricing.get("cardmarket") or {}
                if market:
                    card["cardmarket"] = {
                        "currency": "EUR", "updatedAt": market.get("updated"),
                        "low": market.get("lowPrice"), "trend": market.get("trendPrice"),
                        "avg1": market.get("avg1"), "avg7": market.get("avg7"), "avg30": market.get("avg30"),
                    }
            if count % 500 == 0:
                print(f"  {count}/{len(jobs)}", flush=True)
    for path, cards in loaded.items():
        write_json(path, cards)
    print(f"  updated {updated} TCGplayer card prices")


def write_metadata():
    total = priced = 0
    sources = {}
    for filename in os.listdir(CARDS):
        if not filename.endswith(".json"):
            continue
        for card in json.load(open(os.path.join(CARDS, filename), encoding="utf-8")):
            total += 1
            has_tcg = any(values.get("market") is not None for values in card.get("tcgplayer", {}).get("prices", {}).values())
            has_cm = any(card.get("cardmarket", {}).get(key) is not None for key in ("trend", "avg7", "low"))
            if has_tcg or has_cm:
                priced += 1
                source = card.get("priceSource") or ("TCGplayer" if has_tcg else "Cardmarket")
                sources[source] = sources.get(source, 0) + 1
    write_json(os.path.join(DATA, "pricing-meta.json"), {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "totalCards": total, "cardsWithPrices": priced, "cardsWithoutPrices": total - priced,
        "sources": sources,
    })


def write_search_index():
    """Build the compact browser index used for name/number searches."""
    cards_by_id = {}
    for filename in sorted(os.listdir(CARDS)):
        if not filename.endswith(".json"):
            continue
        for card in json.load(open(os.path.join(CARDS, filename), encoding="utf-8")):
            set_id = card.get("set", {}).get("id")
            if not card.get("id") or not set_id:
                continue
            searchable = " ".join(str(value) for value in (
                card.get("name", ""), card.get("number", ""), card.get("id", ""),
                card.get("set", {}).get("name", ""),
                card.get("language", ""), card.get("searchTerms", ""),
            ) if value).lower()
            cards_by_id[card["id"]] = {
                "id": card["id"], "setId": set_id, "search": searchable,
            }
    write_json(os.path.join(DATA, "card-search-index.json"), {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "cards": list(cards_by_id.values()),
    })
    print(f"Wrote local search index for {len(cards_by_id)} cards")


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--catalog-only", action="store_true")
    group.add_argument("--prices-only", action="store_true")
    parser.add_argument("--workers", type=int, default=24)
    args = parser.parse_args()
    if not args.prices_only:
        refresh_scrydex_catalog()
    if not args.catalog_only:
        refresh_prices(args.workers)
    write_metadata()
    write_search_index()


if __name__ == "__main__":
    main()
