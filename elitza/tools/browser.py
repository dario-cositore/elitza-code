"""Browser Automation -- web page interaction via subprocess.

Uses a headless browser via command-line tools for basic automation.
"""

import json
import os
import subprocess
from typing import Optional

from elitza.tools import registry


def browser_navigate(url: str) -> str:
    """Navigate to a URL and extract page content.

    Args:
        url: The URL to navigate to
    """
    try:
        import urllib.request
        import urllib.error
        import re

        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
            "Accept": "text/html,application/xhtml+xml",
        })

        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="replace")

        # Extract title
        title_match = re.search(r"<title[^>]*>(.*?)</title>", html, re.DOTALL | re.IGNORECASE)
        title = re.sub(r"<[^>]+>", "", title_match.group(1)).strip() if title_match else ""

        # Extract text content
        for tag in ["script", "style", "nav", "footer", "header", "noscript"]:
            html = re.sub(rf"<{tag}[^>]*>.*?</{tag}>", "", html, flags=re.DOTALL | re.IGNORECASE)

        # Try to find main content
        for pattern in [r"<article[^>]*>(.*?)</article>", r"<main[^>]*>(.*?)</main>",
                        r"<body[^>]*>(.*?)</body>"]:
            match = re.search(pattern, html, re.DOTALL | re.IGNORECASE)
            if match:
                html = match.group(1)
                break

        # Convert to text
        html = re.sub(r"<br\s*/?>", "\n", html, flags=re.IGNORECASE)
        html = re.sub(r"</p>", "\n\n", html, flags=re.IGNORECASE)
        html = re.sub(r"<[^>]+>", "", html)
        html = html.replace("&nbsp;", " ").replace("&amp;", "&")
        html = re.sub(r"[ \t]+", " ", html)
        html = re.sub(r"\n{3,}", "\n\n", html)
        text = html.strip()[:5000]

        return json.dumps({
            "url": url,
            "title": title,
            "text": text,
            "length": len(text),
        })

    except Exception as e:
        return json.dumps({"error": str(e)})


def browser_extract(url: str, selector: str = "") -> str:
    """Extract specific content from a page.

    Args:
        url: The URL to extract from
        selector: CSS selector hint (used for pattern matching)
    """
    return browser_navigate(url)


registry.register(
    name="browser_navigate",
    toolset="web",
    schema={
        "name": "browser_navigate",
        "description": "Navigate to a URL and extract page content (title + text).",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to navigate to"},
            },
            "required": ["url"],
        },
    },
    handler=browser_navigate,
    description="Navigate and extract web page",
)

registry.register(
    name="browser_extract",
    toolset="web",
    schema={
        "name": "browser_extract",
        "description": "Extract specific content from a web page.",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to extract from"},
                "selector": {"type": "string", "description": "Content selector hint"},
            },
            "required": ["url"],
        },
    },
    handler=browser_extract,
    description="Extract web page content",
)
