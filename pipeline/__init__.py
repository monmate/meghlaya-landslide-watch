"""Data pipeline for Meghalaya Road Landslide Watch.

Builds road segments, terrain features and a rules-based susceptibility index
from open data, and fetches rainfall for the live view and the storm replay.
"""

# Bump DATA_VERSION to force GitHub Actions to rebuild the static data.
DATA_VERSION = "2026-10-07.1"
