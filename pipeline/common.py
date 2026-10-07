"""Shared helpers: configuration, logging, the build report and HTTP downloads."""

from __future__ import annotations

import datetime as dt
import logging
import time
from pathlib import Path
from typing import Any

import requests
import yaml
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = ROOT / "config"
CACHE_DIR = ROOT / "data" / "cache"

USER_AGENT = (
    "MeghalayaRoadLandslideWatch/0.1 (hackathon prototype; "
    "https://github.com/monmate/meghlaya-landslide-watch)"
)

log = logging.getLogger("mlw")


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )


def utcnow_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def load_config() -> tuple[dict[str, Any], dict[str, Any]]:
    """Return (region config, risk config) from config/*.yaml."""
    with open(CONFIG_DIR / "region.yaml", encoding="utf-8") as f:
        region = yaml.safe_load(f)
    with open(CONFIG_DIR / "risk.yaml", encoding="utf-8") as f:
        risk = yaml.safe_load(f)
    return region, risk


class Report:
    """Collects what the build did, so it can be committed back as Markdown."""

    def __init__(self, title: str) -> None:
        self.title = title
        self.started = time.time()
        self.lines: list[str] = []
        self.warnings: list[str] = []
        self.sources: dict[str, dict[str, Any]] = {}
        self.counts: dict[str, Any] = {}

    def note(self, msg: str) -> None:
        log.info(msg)
        self.lines.append(msg)

    def warn(self, msg: str) -> None:
        log.warning(msg)
        self.warnings.append(msg)

    def source(self, key: str, **info: Any) -> None:
        info.setdefault("retrieved_at", utcnow_iso())
        self.sources[key] = info

    def count(self, key: str, value: Any) -> None:
        self.counts[key] = value
        log.info("%s = %s", key, value)

    def to_markdown(self, status: str) -> str:
        took = time.time() - self.started
        out = [f"# {self.title}", "", f"- Status: **{status}**",
               f"- Finished: {utcnow_iso()} (took {took:.0f} s)", ""]
        if self.counts:
            out += ["## Counts", "", "| Item | Value |", "| --- | --- |"]
            out += [f"| {k} | {v} |" for k, v in self.counts.items()]
            out.append("")
        if self.warnings:
            out += ["## Warnings", ""] + [f"- {w}" for w in self.warnings] + [""]
        if self.sources:
            out += ["## Sources used", "", "| Source | Details |", "| --- | --- |"]
            for k, v in self.sources.items():
                details = "; ".join(f"{kk}: {vv}" for kk, vv in v.items())
                out.append(f"| {k} | {details} |")
            out.append("")
        if self.lines:
            out += ["## Log", ""] + [f"- {line}" for line in self.lines] + [""]
        return "\n".join(out)


def http_session() -> requests.Session:
    """A session with retries and backoff on transient errors."""
    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    retry = Retry(
        total=4,
        backoff_factor=3,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET", "POST"],
        respect_retry_after_header=True,
    )
    adapter = HTTPAdapter(max_retries=retry)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def download(url: str, dest: Path, session: requests.Session,
             timeout: tuple[float, float] = (20, 600)) -> Path:
    """Stream a URL to dest (cached: an existing file is reused)."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with session.get(url, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
    tmp.rename(dest)
    return dest
