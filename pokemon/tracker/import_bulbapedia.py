#!/usr/bin/env python3
"""Restore per-card Bulbapedia links from personal.xlsx into the static catalog.

The workbook stores each URL as a hyperlink on the card name in column B.
This importer uses only Python's standard library and can be rerun whenever
the workbook or catalog changes.

Usage:
  python3 import_bulbapedia.py --input ../../../personal.xlsx
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import glob
import json
import os
import re
from urllib.parse import parse_qs, unquote, urlparse
import xml.etree.ElementTree as ET
import zipfile

ROOT = os.path.dirname(__file__)
DATA = os.path.join(ROOT, "data")
CARDS = os.path.join(DATA, "cards")
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships"

SET_ALIASES = {
    "Base Set": ["Base"],
    "X and Y": ["XY"],
    "X and Y Promos": ["XY Black Star Promos"],
    "Sun and Moon": ["Sun & Moon"],
    "Sun and Moon Promos": ["SM Black Star Promos"],
    "Sword and Shield": ["Sword & Shield"],
    "Sword and Shield Promos": ["SWSH Black Star Promos"],
    "EX Trainer Kit": ["EX Trainer Kit Latias", "EX Trainer Kit Latios"],
    "EX Trainer Kit 2": ["EX Trainer Kit 2 Plusle", "EX Trainer Kit 2 Minun"],
}


def normalize(value):
    return re.sub(r"[^a-z0-9]", "", str(value).casefold())


def number_keys(value):
    value = str(value).split("/", 1)[0].strip()
    if value.endswith(".0"):
        value = value[:-2]
    exact = normalize(value).lstrip("0") or "0"
    keys = {exact}
    suffix = re.search(r"([0-9]+[a-z]?)$", exact)
    if suffix:
        keys.add(suffix.group(1).lstrip("0") or "0")
    return keys


def number_from_bulbapedia(url):
    """Extract the printed number from a Bulbapedia card-page URL."""
    parsed = urlparse(unquote(url))
    title = parse_qs(parsed.query).get("title", [parsed.path.rsplit("/", 1)[-1]])[0]
    match = re.search(r"_([A-Za-z]*[0-9]+[a-z]?)\)?$", title)
    return match.group(1) if match else ""


def shared_strings(archive):
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    tag = "{%s}t" % NS["m"]
    return ["".join(node.text or "" for node in item.iter(tag))
            for item in root.findall("m:si", NS)]


def workbook_sheets(archive):
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {node.attrib["Id"]: node.attrib["Target"]
               for node in relationships.findall(f"{{{PACKAGE_REL}}}Relationship")}
    relation_key = f"{{{OFFICE_REL}}}id"
    for sheet in workbook.findall("m:sheets/m:sheet", NS):
        target = targets[sheet.attrib[relation_key]]
        yield sheet.attrib["name"], "xl/" + target.lstrip("/")


def sheet_rows(archive, path, strings):
    root = ET.fromstring(archive.read(path))
    values = {}
    for cell in root.findall(".//m:sheetData/m:row/m:c", NS):
        value = cell.find("m:v", NS)
        text = "" if value is None else value.text or ""
        if cell.attrib.get("t") == "s" and text:
            text = strings[int(text)]
        values[cell.attrib.get("r", "")] = text.strip()

    relation_path = path.rsplit("/", 1)[0] + "/_rels/" + path.rsplit("/", 1)[1] + ".rels"
    relations = {}
    if relation_path in archive.namelist():
        root = ET.fromstring(archive.read(relation_path))
        relations = {node.attrib["Id"]: node.attrib.get("Target", "")
                     for node in root.findall(f"{{{PACKAGE_REL}}}Relationship")}

    root = ET.fromstring(archive.read(path))
    for link in root.findall(".//m:hyperlinks/m:hyperlink", NS):
        cell = link.attrib.get("ref", "")
        if not cell.startswith("B"):
            continue
        url = relations.get(link.attrib.get(f"{{{OFFICE_REL}}}id", ""), "")
        if "bulbapedia.bulbagarden.net/" not in url.lower():
            continue
        row = re.sub(r"\D", "", cell)
        yield {
            "number": values.get("A" + row, ""),
            "name": values.get("B" + row, ""),
            "url": url,
            "cell": cell,
        }


def catalog():
    sets = json.load(open(os.path.join(DATA, "sets.json"), encoding="utf-8"))
    sets_by_name = {normalize(item["name"]): item for item in sets}
    files = {}
    cards_by_set = defaultdict(list)
    for path in glob.glob(os.path.join(CARDS, "*.json")):
        cards = json.load(open(path, encoding="utf-8"))
        files[path] = cards
        for card in cards:
            set_id = card.get("set", {}).get("id")
            if set_id:
                cards_by_set[set_id].append(card)
    return sets_by_name, cards_by_set, files


def set_names_for_sheet(sheet_name, row_number):
    if sheet_name == "Hidden Fates" and str(row_number).upper().startswith("SV"):
        return ["Hidden Fates Shiny Vault"]
    aliases = SET_ALIASES.get(sheet_name)
    if aliases:
        return aliases
    if sheet_name.startswith("EX "):
        return [sheet_name[3:]]
    if normalize(sheet_name).startswith("mcdonaldscollection"):
        year = re.search(r"(20\d{2})", sheet_name)
        return [f"McDonald's Collection {year.group(1)}"] if year else [sheet_name]
    return [sheet_name]


def write_json(path, value):
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", help="Path to personal.xlsx")
    args = parser.parse_args()
    candidates = [args.input] if args.input else glob.glob(os.path.join(ROOT, "../../../personal.xlsx"))
    if not candidates or not candidates[0] or not os.path.exists(candidates[0]):
        parser.error("personal.xlsx was not found; pass it with --input")

    sets_by_name, cards_by_set, files = catalog()
    card_paths = {card["id"]: path for path, cards in files.items() for card in cards}
    matched = {}
    unmatched = []

    with zipfile.ZipFile(os.path.abspath(candidates[0])) as archive:
        strings = shared_strings(archive)
        for sheet_name, sheet_path in workbook_sheets(archive):
            for row in sheet_rows(archive, sheet_path, strings):
                set_ids = []
                for name in set_names_for_sheet(sheet_name, row["number"]):
                    set_info = sets_by_name.get(normalize(name))
                    if set_info:
                        set_ids.append(set_info["id"])
                all_candidates = [card for set_id in set_ids for card in cards_by_set[set_id]]
                source_numbers = number_keys(row["number"])
                url_number = number_from_bulbapedia(row["url"])
                if url_number:
                    source_numbers.update(number_keys(url_number))
                candidates_for_row = [card for card in all_candidates
                                      if number_keys(card.get("number", "")) & source_numbers]
                name_matches = [card for card in candidates_for_row
                                if normalize(card.get("name", "")) == normalize(row["name"])]
                all_name_matches = [card for card in all_candidates
                                    if normalize(card.get("name", "")) == normalize(row["name"])]
                card = name_matches[0] if len(name_matches) == 1 else (
                    candidates_for_row[0] if len(candidates_for_row) == 1 else (
                    all_name_matches[0] if len(all_name_matches) == 1 else None))
                if card:
                    matched[card["id"]] = row["url"]
                else:
                    unmatched.append({"sheet": sheet_name, **row})

    for card_id, url in matched.items():
        path = card_paths[card_id]
        card = next(item for item in files[path] if item["id"] == card_id)
        card["bulbapedia"] = url
    for path, cards in files.items():
        if any(card["id"] in matched for card in cards):
            write_json(path, cards)

    report = os.path.join(DATA, "bulbapedia-unmatched.json")
    write_json(report, {"sourceFile": os.path.basename(candidates[0]), "entries": unmatched})
    print(f"Restored {len(matched)} Bulbapedia links")
    print(f"Wrote {len(unmatched)} unmatched workbook links to {os.path.relpath(report, ROOT)}")


if __name__ == "__main__":
    main()
