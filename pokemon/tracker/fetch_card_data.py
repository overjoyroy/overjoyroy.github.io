#!/usr/bin/env python3
"""Backward-compatible entry point for the catalog and price updater.

PokemonTCG.io's old feed is no longer used. See update_catalog.py for the
current Scrydex catalog + TCGdex pricing workflow and command-line options.
"""

from update_catalog import main


if __name__ == "__main__":
    main()
