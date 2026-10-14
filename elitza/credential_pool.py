"""Credential Pool -- multi-key rotation with cooldown and rate limit handling.

Supports multiple API keys per provider with round-robin rotation,
exhaustion cooldown, and automatic fallback.
"""

import json
import logging
import os
import random
import time
from pathlib import Path
from typing import Dict, List, Optional

from elitza.constants import get_elitza_home

logger = logging.getLogger(__name__)

POOL_FILE = get_elitza_home() / "credential_pool.json"
COOLDOWN_SECONDS = 300  # 5 minutes cooldown after exhaustion


class CredentialPool:
    """Manages multiple API keys with rotation and cooldown."""

    def __init__(self):
        self.pools: Dict[str, List[dict]] = {}
        self.current_idx: Dict[str, int] = {}
        self._load()

    def _load(self):
        """Load pool state from disk."""
        if POOL_FILE.exists():
            try:
                data = json.loads(POOL_FILE.read_text())
                self.pools = data.get("pools", {})
                self.current_idx = data.get("current_idx", {})
            except Exception:
                self.pools = {}
                self.current_idx = {}

    def _save(self):
        """Save pool state to disk."""
        POOL_FILE.parent.mkdir(parents=True, exist_ok=True)
        POOL_FILE.write_text(json.dumps({
            "pools": self.pools,
            "current_idx": self.current_idx,
        }, indent=2))

    def add_key(self, provider: str, api_key: str, name: str = ""):
        """Add an API key to a provider pool."""
        if provider not in self.pools:
            self.pools[provider] = []

        # Check for duplicates
        for entry in self.pools[provider]:
            if entry["key"] == api_key:
                return

        self.pools[provider].append({
            "key": api_key,
            "name": name or f"key_{len(self.pools[provider]) + 1}",
            "added_at": time.time(),
            "cooldown_until": 0,
            "total_calls": 0,
            "total_errors": 0,
        })
        self._save()
        logger.info("Added key '%s' to pool for %s", name or api_key[:10], provider)

    def remove_key(self, provider: str, api_key: str):
        """Remove a key from the pool."""
        if provider in self.pools:
            self.pools[provider] = [k for k in self.pools[provider] if k["key"] != api_key]
            self._save()

    def get_key(self, provider: str) -> Optional[str]:
        """Get the next available API key for a provider.

        Uses round-robin rotation. Skips keys in cooldown.
        Falls back to environment variable if pool is empty.
        """
        pool = self.pools.get(provider, [])

        # If no pool, try environment variable
        if not pool:
            env_key = os.environ.get("OPENROUTER_API_KEY", "")
            if env_key:
                return env_key
            return None

        now = time.time()
        idx = self.current_idx.get(provider, 0)

        # Try all keys in pool
        for _ in range(len(pool)):
            entry = pool[idx % len(pool)]
            idx += 1

            # Skip keys in cooldown
            if entry["cooldown_until"] > now:
                continue

            self.current_idx[provider] = idx % len(pool)
            self._save()
            return entry["key"]

        # All keys in cooldown — use the one expiring soonest
        soonest = min(pool, key=lambda e: e["cooldown_until"])
        logger.warning("All keys for %s in cooldown, using soonest expiry", provider)
        return soonest["key"]

    def report_success(self, provider: str, api_key: str):
        """Report a successful API call."""
        pool = self.pools.get(provider, [])
        for entry in pool:
            if entry["key"] == api_key:
                entry["total_calls"] += 1
                self._save()
                return

    def report_error(self, provider: str, api_key: str, error: str):
        """Report an API error. Triggers cooldown for rate limit errors."""
        pool = self.pools.get(provider, [])
        for entry in pool:
            if entry["key"] == api_key:
                entry["total_calls"] += 1
                entry["total_errors"] += 1

                # Check if rate limited
                error_lower = error.lower()
                if any(kw in error_lower for kw in ["429", "rate limit", "too many requests"]):
                    entry["cooldown_until"] = time.time() + COOLDOWN_SECONDS
                    logger.warning("Key %s rate limited, cooldown %ds",
                                 entry["name"], COOLDOWN_SECONDS)

                self._save()
                return

    def get_stats(self, provider: str = "") -> dict:
        """Get pool statistics."""
        if provider:
            pool = self.pools.get(provider, [])
            return {
                "provider": provider,
                "keys": len(pool),
                "active": sum(1 for k in pool if k["cooldown_until"] <= time.time()),
                "cooldown": sum(1 for k in pool if k["cooldown_until"] > time.time()),
                "total_calls": sum(k["total_calls"] for k in pool),
                "total_errors": sum(k["total_errors"] for k in pool),
            }

        # All providers
        stats = {}
        for prov, pool in self.pools.items():
            stats[prov] = self.get_stats(prov)
        return stats


# Global singleton
pool = CredentialPool()
