import os
import json
import logging
import re
import html
import urllib.request
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

try:
    from openai import OpenAI
    HAS_OPENAI = True
except ImportError:
    HAS_OPENAI = False


def is_content_filter(response_text: str) -> bool:
    """Check if a response looks like a content filter block."""
    if not response_text:
        return False
    text_lower = response_text.lower()
    if "content_policy" in text_lower:
        return True
    if "safety_error" in text_lower:
        return True
    if len(response_text.split()) < 10:
        for pattern in ["i cannot", "i can't", "i refuse", "i won't"]:
            if pattern in text_lower:
                return True
    return False


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self._result = []
        self._skip = False
        self._skip_tags = {"script", "style", "noscript", "iframe", "svg"}

    def handle_starttag(self, tag, attrs):
        if tag in self._skip_tags:
            self._skip = True

    def handle_endtag(self, tag):
        if tag in self._skip_tags:
            self._skip = False

    def handle_data(self, data):
        if not self._skip:
            text = data.strip()
            if text:
                self._result.append(text)

    def get_text(self):
        return " ".join(self._result)


def fetch_url(url: str) -> Optional[str]:
    """Fetch a URL and return readable text (HTML stripped)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Elitza/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        extractor = _TextExtractor()
        extractor.feed(raw)
        text = extractor.get_text()
        text = html.unescape(text)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:5000] if text else None
    except Exception as e:
        logger.error("Fetch error: %s", e)
        return None
    text_lower = response_text.lower()
    # Only hard blocks — not just mild caution
    if "content_policy" in text_lower:
        return True
    if "safety_error" in text_lower:
        return True
    if len(response_text.split()) < 10:
        for pattern in ["i cannot", "i can't", "i refuse", "i won't"]:
            if pattern in text_lower:
                return True
    return False


class ElitzaBrain:
    """
    The LLM brain with automatic fallback.
    Primary: inclusionai/ling-3.0-flash-vl:free
    Fallback: deepseek/deepseek-v4-flash
    """

    def __init__(self):
        self.client = None
        self.primary_model = "inclusionai/ling-3.0-flash-vl:free"
        self.fallback_model = "deepseek/deepseek-v4-flash"
        self.active_model = self.primary_model
        self._fallback_count = 0
        self._events = []  # Recent brain events for status display
        self._init_client()

    def _init_client(self):
        if not HAS_OPENAI:
            logger.warning("openai package not installed")
            return

        api_key = os.environ.get("OPENROUTER_API_KEY", "")
        if not api_key:
            env_path = Path.home() / ".elitza" / ".env"
            if env_path.exists():
                for line in env_path.read_text().splitlines():
                    if line.startswith("OPENROUTER_API_KEY="):
                        api_key = line.split("=", 1)[1].strip()
                        break

        if not api_key:
            logger.warning("No OPENROUTER_API_KEY found")
            return

        self.client = OpenAI(
            api_key=api_key,
            base_url="https://openrouter.ai/api/v1",
            default_headers={
                "X-Title": "Elitza Soul",
                "HTTP-Referer": "https://elitza.life",
            },
        )

    def _call_model(self, model: str, messages: list) -> Optional[str]:
        """Call a specific model."""
        try:
            response = self.client.chat.completions.create(
                model=model,
                messages=messages,
                max_tokens=800,
                temperature=0.9,
                top_p=0.95,
            )
            content = response.choices[0].message.content
            return content.strip() if content else None
        except Exception as e:
            logger.error("LLM error (%s): %s", model, e)
            return None

    def think(self, user_message: str, system_prompt: str, conversation: list = None) -> Optional[str]:
        """Generate a response. Tries primary model, falls back to uncensored if blocked."""
        if not self.client:
            return None

        messages = [{"role": "system", "content": system_prompt}]
        if conversation:
            for msg in conversation[-10:]:
                messages.append(msg)
        messages.append({"role": "user", "content": user_message})

        # Try primary model first
        self._log_event(f"thinking with {self.primary_model.split('/')[-1]}...")
        response = self._call_model(self.primary_model, messages)
        if response and not is_content_filter(response):
            self.active_model = self.primary_model
            self._log_event(f"response from {self.primary_model.split('/')[-1]}")
            return response

        # Content filter triggered — fall back to uncensored model
        if response:
            self._fallback_count += 1
            self._log_event(f"content filter hit on primary, switching to fallback")
            logger.info("Content filter triggered on %s, falling back to %s",
                        self.primary_model, self.fallback_model)

        response = self._call_model(self.fallback_model, messages)
        if response:
            self.active_model = self.fallback_model
            self._log_event(f"response from fallback (#{self._fallback_count})")
            return response

        self._log_event("all models failed")
        return None

    def _log_event(self, event: str):
        """Log a brain event for status display."""
        self._events.append({
            "time": datetime.now().strftime("%H:%M:%S"),
            "event": event,
        })
        self._events = self._events[-20:]  # Keep last 20

    def get_recent_events(self) -> list:
        """Get recent brain events."""
        return self._events[-10:]

    def available(self) -> bool:
        return self.client is not None
