"""
Downloads all Pokemon TCG set and card data into static JSON files.
Run periodically to update with new sets/cards.

Output:
  data/sets.json          — all set metadata
  data/cards/{setId}.json — all cards per set

Usage:
  python3 fetch_card_data.py
"""

import json
import os
import ssl
import time
import urllib.request
import urllib.error

SSL_CTX = ssl.create_default_context()
try:
    import certifi
    SSL_CTX.load_verify_locations(certifi.where())
except ImportError:
    SSL_CTX.check_hostname = False
    SSL_CTX.verify_mode = ssl.CERT_NONE

API = 'https://api.pokemontcg.io/v2'
OUT_DIR = os.path.join(os.path.dirname(__file__), 'data')
CARDS_DIR = os.path.join(OUT_DIR, 'cards')
SELECT_SETS = 'id,name,series,releaseDate,total,images'
SELECT_CARDS = 'id,name,number,set,images,tcgplayer'


def api_get(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Porydex/1.0'})
            with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, TimeoutError) as e:
            print(f'  Retry {attempt+1}/{retries}: {e}')
            time.sleep(2 ** attempt)
    raise RuntimeError(f'Failed after {retries} retries: {url}')


def fetch_sets():
    print('Fetching all sets...')
    data = api_get(f'{API}/sets?pageSize=250&orderBy=releaseDate&select={SELECT_SETS}')
    sets = data.get('data', [])
    print(f'  {len(sets)} sets found')
    return sets


def fetch_cards(set_id, set_name):
    cards = []
    page = 1
    while True:
        url = (f'{API}/cards?q=set.id:{set_id}&orderBy=number'
               f'&pageSize=250&page={page}&select={SELECT_CARDS}')
        data = api_get(url)
        batch = data.get('data', [])
        cards.extend(batch)
        total = data.get('totalCount', len(cards))
        if not batch or len(cards) >= total:
            break
        page += 1
    return cards


def main():
    os.makedirs(CARDS_DIR, exist_ok=True)

    sets = fetch_sets()
    with open(os.path.join(OUT_DIR, 'sets.json'), 'w') as f:
        json.dump(sets, f, separators=(',', ':'))
    print(f'Wrote data/sets.json ({len(sets)} sets)')

    for i, s in enumerate(sets, 1):
        sid = s['id']
        name = s.get('name', sid)
        out_path = os.path.join(CARDS_DIR, f'{sid}.json')

        if os.path.exists(out_path):
            existing = json.load(open(out_path))
            if len(existing) >= s.get('total', 0):
                print(f'  [{i}/{len(sets)}] {name} — cached ({len(existing)} cards)')
                continue

        print(f'  [{i}/{len(sets)}] {name} — fetching...', end='', flush=True)
        cards = fetch_cards(sid, name)
        with open(out_path, 'w') as f:
            json.dump(cards, f, separators=(',', ':'))
        print(f' {len(cards)} cards')
        time.sleep(0.3)

    total_cards = sum(len(json.load(open(os.path.join(CARDS_DIR, f))))
                      for f in os.listdir(CARDS_DIR) if f.endswith('.json'))
    print(f'\nDone — {len(sets)} sets, {total_cards} cards total')


if __name__ == '__main__':
    main()
