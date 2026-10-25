#!/usr/bin/env python3
"""Convert RotomAmiti's cameo workbook into Porydex's static cameo index.

This intentionally uses only Python's standard library, so future workbook
updates do not require installing Excel packages.

Usage:
  python3 import_cameos.py --input ../../../cameo261025.xlsx

Outputs:
  data/cameos.json            matched entries used by the website
  data/cameos-unmatched.json  entries needing aliases or missing catalog cards
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
import glob
import hashlib
import json
import os
import re
import xml.etree.ElementTree as ET
import zipfile

ROOT = os.path.dirname(__file__)
DATA = os.path.join(ROOT, "data")
CARDS = os.path.join(DATA, "cards")
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

# Workbook labels that intentionally differ from Porydex's catalog names.
# Add aliases here when a future import reports a renamed-but-known set.
SET_ALIASES = {
    "BW Promos": "BW Black Star Promos",
    "DP Promos": "DP Black Star Promos",
    "Expedition": "Expedition Base Set",
    "HGSS Promos": "HGSS Black Star Promos",
    "MEP Promos": "Mega Evolution Black Star Promos",
    "Nintendo Promos": "Nintendo Black Star Promos",
    "SM Promos": "SM Black Star Promos",
    "SV Promos": "Scarlet & Violet Black Star Promos",
    "SWSH Promos": "SWSH Black Star Promos",
    "Undaunted": "HS—Undaunted",
    "XY Promos": "XY Black Star Promos",
}

# The catalog stores modern artwork galleries as their own sets even though
# the workbook labels them with the parent expansion name.
NUMBER_PREFIX_SET_SUFFIXES = {
    "GG": " Galarian Gallery",
    "TG": " Trainer Gallery",
}


def normalize(value):
    return re.sub(r"[^a-z0-9]", "", str(value).casefold())


def card_names_match(workbook_name, catalog_name):
    """Allow harmless naming variants without accepting a same-number card."""
    workbook = normalize(workbook_name)
    catalog = normalize(catalog_name)
    if workbook == catalog:
        return True
    # The workbook sometimes adds a character/person qualifier in brackets,
    # while older catalog names include a longer card-series prefix.
    workbook_base = normalize(re.sub(r"\s*\[[^]]+\]\s*$", "", str(workbook_name)))
    if workbook_base == catalog:
        return True
    if min(len(workbook_base), len(catalog)) >= 6 and (
            workbook_base in catalog or catalog in workbook_base):
        return True
    return SequenceMatcher(None, workbook_base, catalog).ratio() >= 0.88


def normalize_number(value):
    value = str(value).strip()
    if value.endswith(".0"):
        value = value[:-2]
    return normalize(value).lstrip("0") or "0"


def number_keys(value):
    """Return exact and prefix-free forms (SM078 and 78, for example)."""
    exact = normalize_number(value)
    keys = [exact]
    suffix = re.search(r"([0-9]+[a-z]?)$", exact)
    if suffix:
        prefix_free = suffix.group(1).lstrip("0") or "0"
        if prefix_free != exact:
            keys.append(prefix_free)
    return keys


def write_json(path, value):
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(temp, path)


def shared_strings(archive):
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    tag = "{%s}t" % NS["m"]
    return ["".join(node.text or "" for node in item.iter(tag))
            for item in root.findall("m:si", NS)]


def workbook_sheets(archive):
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    targets = {node.attrib["Id"]: node.attrib["Target"]
               for node in rels.findall(f"{{{rel_ns}}}Relationship")}
    rid_key = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    for sheet in workbook.findall("m:sheets/m:sheet", NS):
        target = targets[sheet.attrib[rid_key]]
        yield sheet.attrib["name"], "xl/" + target.lstrip("/")


def cell_values(archive, path, strings):
    root = ET.fromstring(archive.read(path))
    for row in root.findall(".//m:sheetData/m:row", NS):
        values = {}
        for cell in row.findall("m:c", NS):
            column = re.match(r"[A-Z]+", cell.attrib.get("r", ""))
            value = cell.find("m:v", NS)
            text = "" if value is None else value.text or ""
            if cell.attrib.get("t") == "s" and text:
                text = strings[int(text)]
            if column:
                values[column.group()] = text.strip()
        yield values


def read_cameos(path):
    rows = []
    with zipfile.ZipFile(path) as archive:
        strings = shared_strings(archive)
        for sheet_name, sheet_path in workbook_sheets(archive):
            if not re.fullmatch(r"Gen [1-9]", sheet_name):
                continue
            dex_number = pokemon = card_name = ""
            for row_number, row in enumerate(cell_values(archive, sheet_path, strings), 1):
                if row_number == 1:
                    continue
                dex_number = row.get("A") or dex_number
                pokemon = row.get("B") or pokemon
                card_name = row.get("C") or card_name
                if not all((pokemon, card_name, row.get("D"), row.get("E"))):
                    continue
                rows.append({
                    "pokemon": pokemon,
                    "dex": dex_number[:-2] if dex_number.endswith(".0") else dex_number,
                    "generation": int(sheet_name.split()[-1]),
                    "cardName": card_name,
                    "setName": row["D"],
                    "number": row["E"],
                    "notes": row.get("F", ""),
                    "sheet": sheet_name,
                    "row": row_number,
                })
    return rows


def local_catalog():
    sets = json.load(open(os.path.join(DATA, "sets.json"), encoding="utf-8"))
    sets_by_name = {normalize(item["name"]): item for item in sets}
    cards = defaultdict(list)
    for filename in glob.glob(os.path.join(CARDS, "*.json")):
        for card in json.load(open(filename, encoding="utf-8")):
            set_id = card.get("set", {}).get("id")
            if set_id:
                for number_key in number_keys(card.get("number", "")):
                    candidates = cards[(set_id, number_key)]
                    if not any(candidate["id"] == card["id"] for candidate in candidates):
                        candidates.append(card)
    return sets_by_name, cards


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="Path to RotomAmiti's .xlsx workbook")
    args = parser.parse_args()
    candidates = [args.input] if args.input else sorted(
        glob.glob(os.path.join(ROOT, "../../../cameo*.xlsx")), reverse=True)
    if not candidates or not candidates[0] or not os.path.exists(candidates[0]):
        parser.error("No cameo workbook found; pass --input /path/to/cameo.xlsx")
    input_path = os.path.abspath(candidates[0])

    sets_by_name, cards = local_catalog()
    aliases = {normalize(source): normalize(target) for source, target in SET_ALIASES.items()}
    matched = defaultdict(dict)
    unmatched = []

    for entry in read_cameos(input_path):
        set_key = normalize(entry["setName"])
        set_info = sets_by_name.get(aliases.get(set_key, set_key))
        number_prefix = re.match(r"^([A-Za-z]+)", str(entry["number"]).strip())
        gallery_suffix = NUMBER_PREFIX_SET_SUFFIXES.get(
            number_prefix.group(1).upper() if number_prefix else "")
        if gallery_suffix:
            gallery_set = sets_by_name.get(normalize(entry["setName"] + gallery_suffix))
            if gallery_set:
                set_info = gallery_set
        card = None
        if set_info:
            for number_key in number_keys(entry["number"]):
                candidates = cards.get((set_info["id"], number_key), [])
                name_matches = [candidate for candidate in candidates
                                if card_names_match(entry["cardName"], candidate.get("name", ""))]
                if name_matches:
                    card = name_matches[0]
                    break
        if not card:
            unmatched.append(entry)
            continue
        pokemon_key = normalize(entry["pokemon"])
        existing = matched[pokemon_key].setdefault(card["id"], {
            "id": card["id"], "setId": set_info["id"], "notes": [],
        })
        if entry["notes"] and entry["notes"] not in existing["notes"]:
            existing["notes"].append(entry["notes"])

    display_names = {}
    pokemon_metadata = {}
    for entry in read_cameos(input_path):
        display_names.setdefault(normalize(entry["pokemon"]), entry["pokemon"])
        pokemon_metadata.setdefault(normalize(entry["pokemon"]), {
            "dex": entry["dex"], "generation": entry["generation"],
        })
    unmatched_by_pokemon = defaultdict(list)
    for entry in unmatched:
        key = normalize(entry["pokemon"])
        identity = "|".join((entry["pokemon"], entry["cardName"], entry["setName"], entry["number"]))
        card_id = "cameo-" + hashlib.sha1(identity.encode("utf-8")).hexdigest()[:12]
        unmatched_by_pokemon[key].append({
            "id": card_id,
            "name": entry["cardName"],
            "number": entry["number"],
            "set": {
                "id": "cameo-" + normalize(entry["setName"]),
                "name": entry["setName"],
                "series": "Cameo database",
            },
            "images": {},
            "notes": [entry["notes"]] if entry["notes"] else [],
            "catalogStatus": "unmatched",
        })
    pokemon = {
        key: {
            "name": name,
            **pokemon_metadata[key],
            "cards": list(matched.get(key, {}).values()),
            "unmatched": unmatched_by_pokemon.get(key, []),
        }
        for key, name in sorted(display_names.items(), key=lambda item: item[1])
    }
    matched_rows = sum(len(item["cards"]) for item in pokemon.values())
    metadata = {
        "source": "RotomAmiti's Cameo Pokémon Card Database",
        "sourceFile": os.path.basename(input_path),
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pokemon": len(pokemon),
        "matchedEntries": matched_rows,
        "unmatchedEntries": len(unmatched),
    }
    write_json(os.path.join(DATA, "cameos.json"), {"meta": metadata, "pokemon": pokemon})
    write_json(os.path.join(DATA, "cameos-unmatched.json"), {"meta": metadata, "entries": unmatched})
    print(f"Wrote {matched_rows} matched cameo links for {len(pokemon)} Pokémon")
    print(f"Wrote {len(unmatched)} unmatched entries for future catalog/alias work")


if __name__ == "__main__":
    main()
