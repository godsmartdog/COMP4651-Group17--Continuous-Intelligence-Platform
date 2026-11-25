"""Phase 2 catalog built from bronze GH Archive hours."""

from __future__ import annotations

import sys
from pathlib import Path

_INGESTION = Path(__file__).resolve().parent.parent / "ingestion"
_INGESTION_PATH = str(_INGESTION)
if _INGESTION_PATH not in sys.path:
    sys.path.insert(0, _INGESTION_PATH)
