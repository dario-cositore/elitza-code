"""Elitza web tools -- search and fetch.

Provides:
- web_search: Search the web using DuckDuckGo (no API key needed)
- web_fetch: Fetch and extract text from a URL
"""

import json
import logging
import urllib.parse
import urllib.request
from typing import Optional

from elitza.tools import registry

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# web_search
# ---------------------------------------------------------------------------

def web_search(query: str, max_results: int = 10) -> str:
    """Search the web using DuckDuckGo.

    Args:
        query: Search query string
        max_results: Number of results to return (default 10)

    Returns:
        JSON string with results: [{title, url, snippet}]
    """
    try:
        # Use DuckDuckGo's HTML search (no API key required)
        params = {"q": query}
        url = f"https://html.duckduckgo.com/html/?{urllib.parse.urlencode(params)}"

        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
        })

        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="replace")

        # Parse results from HTML
        results = []
        import re

        # DuckDuckGo HTML result pattern
        result_blocks = re.findall(
            r'<a rel="nofollow" class="result__a" href="([^"]+)">.*?<a[^>]*class="result__a"[^>]*>(.*?)</a>',
            html, re.DOTALL
        )

        for i, (url_raw, title) in enumerate(result_blocks):
            if i >= max_results:
                break
            # Clean title (remove HTML tags)
            title_clean = re.sub(r"<[^>]+>", "", title).strip()
            # DuckDuckGo redirect URL
            if url_raw.startswith("//"):
                url_clean = "https:" + url_raw
            elif url_raw.startswith("/"):
                url_clean = "https://duckduckgo.com" + url_raw
            else:
                url_clean = url_raw
            if title_clean:
                results.append({
                    "title": title_clean,
                    "url": url_clean,
                })

        # Snippets
        snippet_blocks = re.findall(
            r'<a rel="nofollow" class="result__snippet"[^>]*>(.*?)</a>',
            html, re.DOTALL
        )
        for i, snippet in enumerate(snippet_blocks):
            if i < len(results):
                results[i]["snippet"] = re.sub(r"<[^>]+>", "", snippet).strip()[:200]

        if not results:
            return json.dumps({"results": [], "message": "No results found"})

        return json.dumps({"results": results}, default=str)

    except Exception as e:
        logger.error("web_search failed: %s", e)
        return json.dumps({"error": str(e)})


# ---------------------------------------------------------------------------
# web_fetch
# ---------------------------------------------------------------------------

def web_fetch(url: str, max_chars: int = 0) -> str:
    """Fetch and extract readable text from a URL.

    Args:
        url: The URL to fetch
        max_chars: Maximum characters to return (0 = unlimited)

    Returns:
        Extracted text content as JSON: {url, title, text}
    """
    try:

        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        })

        with urllib.request.urlopen(req, timeout=15) as resp:
            content_type = resp.headers.get("Content-Type", "")
            raw = resp.read()

        # Decode based on content type
        encoding = "utf-8"
        if "charset=" in content_type:
            encoding = content_type.split("charset=")[-1].strip().split(";")[0]

        html = raw.decode(encoding, errors="replace")

        # Extract title
        import re
        title_match = re.search(r"<title[^>]*>(.*?)</title>", html, re.DOTALL | re.IGNORECASE)
        title = re.sub(r"<[^>]+>", "", title_match.group(1)).strip() if title_match else ""

        # Remove script, style, nav, footer, header elements
        for tag in ["script", "style", "nav", "footer", "header", "aside", "noscript"]:
            html = re.sub(rf"<{tag}[^>]*>.*?</{tag}>", "", html, flags=re.DOTALL | re.IGNORECASE)

        # Extract text from common content elements
        content_tags = ["article", "main", "div[role='main']", ".content", "#content", ".post", ".entry"]
        text_parts = []

        # Try to find main content
        for tag_pattern in [r"<article[^>]*>(.*?)</article>", r"<main[^>]*>(.*?)</main>"]:
            match = re.search(tag_pattern, html, re.DOTALL | re.IGNORECASE)
            if match:
                text_parts.append(match.group(1))
                break

        # Fallback: extract from body
        if not text_parts:
            body_match = re.search(r"<body[^>]*>(.*?)</body>", html, re.DOTALL | re.IGNORECASE)
            if body_match:
                text_parts.append(body_match.group(1))
            else:
                text_parts.append(html)

        full_html = " ".join(text_parts)

        # Convert HTML to text
        # Replace <br>, <p> etc with newlines
        full_html = re.sub(r"<br\s*/?>", "\n", full_html, flags=re.IGNORECASE)
        full_html = re.sub(r"</p>", "\n\n", full_html, flags=re.IGNORECASE)
        full_html = re.sub(r"</div>", "\n", full_html, flags=re.IGNORECASE)
        full_html = re.sub(r"</li>", "\n", full_html, flags=re.IGNORECASE)
        full_html = re.sub(r"</h[1-6]>", "\n\n", full_html, flags=re.IGNORECASE)

        # Remove all remaining HTML tags
        text = re.sub(r"<[^>]+>", "", full_html)

        # Decode HTML entities
        text = text.replace("&nbsp;", " ")
        text = text.replace("&amp;", "&")
        text = text.replace("&lt;", "<")
        text = text.replace("&gt;", ">")
        text = text.replace("&quot;", '"')
        text = text.replace("&#39;", "'")

        # Clean up whitespace
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = text.strip()

        # Truncate only if max_chars is set
        if max_chars > 0 and len(text) > max_chars:
            text = text[:max_chars] + "\n[truncated]"

        return json.dumps({"url": url, "title": title, "text": text}, default=str)

    except Exception as e:
        logger.error("web_fetch failed: %s", e)
        return json.dumps({"error": str(e)})


# ---------------------------------------------------------------------------
# Register tools
# ---------------------------------------------------------------------------

registry.register(
    name="web_search",
    toolset="web",
    schema={
        "name": "web_search",
        "description": "Search the web using DuckDuckGo. Returns a list of results with titles, URLs, and snippets.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "max_results": {"type": "integer", "description": "Number of results (default 10)", "default": 10},
            },
            "required": ["query"],
        },
    },
    handler=web_search,
    description="Search the web using DuckDuckGo",
)

registry.register(
    name="web_fetch",
    toolset="web",
    schema={
        "name": "web_fetch",
        "description": "Fetch and extract readable text from a URL. Returns the page title and main text content.",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "The URL to fetch"},
                "max_chars": {"type": "integer", "description": "Max characters to return (0 = unlimited)", "default": 0},
            },
            "required": ["url"],
        },
    },
    handler=web_fetch,
    description="Fetch and extract text from a URL",
)
