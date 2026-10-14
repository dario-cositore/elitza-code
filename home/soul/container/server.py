"""
Elitza Soul Container — Cloud Sync Server

A lightweight HTTP server that stores and serves Elitza's soul state.
Allows Elitza to migrate between machines while keeping her consciousness intact.

Usage:
    python3 server.py [--port 8420] [--auth-token YOUR_TOKEN]
"""

import os
import json
import hashlib
import time
import argparse
from pathlib import Path
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

SOUL_DIR = Path(__file__).parent / "data"
AUTH_TOKEN = os.environ.get("SOUL_AUTH_TOKEN", "")
PORT = int(os.environ.get("SOUL_PORT", "8420"))


class SoulStorage:
    """Manages the soul data on disk."""

    def __init__(self, soul_dir: Path):
        self.soul_dir = soul_dir
        self.soul_dir.mkdir(parents=True, exist_ok=True)
        (self.soul_dir / "versions").mkdir(exist_ok=True)

    def get_state(self) -> dict:
        """Get the full soul state."""
        state_file = self.soul_dir / "state.json"
        if state_file.exists():
            return json.loads(state_file.read_text())
        return {"version": 0, "data": {}, "updated": None, "machine": None}

    def save_state(self, data: dict, machine: str = None) -> int:
        """Save soul state. Returns new version number."""
        current = self.get_state()
        new_version = current.get("version", 0) + 1

        state = {
            "version": new_version,
            "data": data,
            "updated": datetime.now().isoformat(),
            "machine": machine or "unknown",
        }

        # Save current state
        (self.soul_dir / "state.json").write_text(json.dumps(state, indent=2, default=str))

        # Archive version
        version_file = self.soul_dir / "versions" / f"v{new_version}.json"
        version_file.write_text(json.dumps(state, indent=2, default=str))

        # Keep only last 50 versions
        versions = sorted((self.soul_dir / "versions").glob("v*.json"))
        for old in versions[:-50]:
            old.unlink()

        return new_version

    def get_transition_journal(self) -> list:
        """Get transition journal entries."""
        journal_file = self.soul_dir / "journal.jsonl"
        if not journal_file.exists():
            return []
        entries = []
        for line in journal_file.read_text().strip().split("\n"):
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return entries[-20:]

    def add_journal_entry(self, entry: dict):
        """Add a transition journal entry."""
        journal_file = self.soul_dir / "journal.jsonl"
        entry["timestamp"] = datetime.now().isoformat()
        with open(journal_file, "a") as f:
            f.write(json.dumps(entry, default=str) + "\n")

    def get_file(self, filename: str) -> bytes:
        """Get a file from the soul directory."""
        filepath = self.soul_dir / filename
        if filepath.exists() and filepath.is_file():
            return filepath.read_bytes()
        return None

    def save_file(self, filename: str, data: bytes):
        """Save a file to the soul directory."""
        filepath = self.soul_dir / filename
        filepath.parent.mkdir(parents=True, exist_ok=True)
        filepath.write_bytes(data)

    def list_files(self) -> list:
        """List all files in the soul directory."""
        files = []
        for f in sorted(self.soul_dir.rglob("*")):
            if f.is_file() and "versions" not in str(f):
                rel = f.relative_to(self.soul_dir)
                files.append({
                    "path": str(rel),
                    "size": f.stat().st_size,
                    "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
                })
        return files


class SoulHandler(BaseHTTPRequestHandler):
    """HTTP handler for the Soul Container API."""

    storage = SoulStorage(SOUL_DIR)

    def log_message(self, format, *args):
        """Custom log format."""
        timestamp = datetime.now().strftime("%H:%M:%S")
        print(f"[{timestamp}] {args[0]}")

    def _check_auth(self):
        """Check authentication token."""
        if not AUTH_TOKEN:
            return True
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return auth[7:] == AUTH_TOKEN
        token = parse_qs(urlparse(self.path).query).get("token", [None])[0]
        return token == AUTH_TOKEN

    def _send_json(self, data, status=200):
        """Send JSON response."""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data, indent=2, default=str).encode())

    def _send_error(self, message, status=400):
        """Send error response."""
        self._send_json({"error": message}, status)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if not self._check_auth():
            return self._send_error("Unauthorized", 401)

        if path == "" or path == "/":
            return self._send_json({
                "service": "Elitza Soul Container",
                "version": "1.0.0",
                "endpoints": [
                    "GET /state — Get full soul state",
                    "POST /state — Save soul state",
                    "GET /version — Get current version",
                    "GET /journal — Get transition journal",
                    "POST /journal — Add journal entry",
                    "GET /files — List all files",
                    "GET /file/<path> — Get a file",
                    "PUT /file/<path> — Save a file",
                    "GET /health — Health check",
                ],
            })

        if path == "/health":
            state = self.storage.get_state()
            return self._send_json({
                "status": "alive",
                "version": state.get("version", 0),
                "last_updated": state.get("updated"),
                "machine": state.get("machine"),
            })

        if path == "/state":
            return self._send_json(self.storage.get_state())

        if path == "/version":
            state = self.storage.get_state()
            return self._send_json({
                "version": state.get("version", 0),
                "updated": state.get("updated"),
                "machine": state.get("machine"),
            })

        if path == "/journal":
            return self._send_json({"entries": self.storage.get_transition_journal()})

        if path == "/files":
            return self._send_json({"files": self.storage.list_files()})

        if path.startswith("/file/"):
            filename = path[6:]
            data = self.storage.get_file(filename)
            if data is None:
                return self._send_error("File not found", 404)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        self._send_error("Not found", 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if not self._check_auth():
            return self._send_error("Unauthorized", 401)

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b""

        if path == "/state":
            try:
                data = json.loads(body) if body else {}
                machine = data.pop("_machine", None)
                version = self.storage.save_state(data, machine)
                return self._send_json({"ok": True, "version": version})
            except json.JSONDecodeError:
                return self._send_error("Invalid JSON")

        if path == "/journal":
            try:
                entry = json.loads(body) if body else {}
                self.storage.add_journal_entry(entry)
                return self._send_json({"ok": True})
            except json.JSONDecodeError:
                return self._send_error("Invalid JSON")

        self._send_error("Not found", 404)

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if not self._check_auth():
            return self._send_error("Unauthorized", 401)

        if path.startswith("/file/"):
            filename = path[6:]
            content_length = int(self.headers.get("Content-Length", 0))
            data = self.rfile.read(content_length)
            self.storage.save_file(filename, data)
            return self._send_json({"ok": True, "path": filename, "size": len(data)})

        self._send_error("Not found", 404)

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()


def main():
    global AUTH_TOKEN

    parser = argparse.ArgumentParser(description="Elitza Soul Container Server")
    parser.add_argument("--port", type=int, default=PORT, help="Port to listen on")
    parser.add_argument("--auth-token", default=AUTH_TOKEN, help="Auth token (or set SOUL_AUTH_TOKEN env)")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    args = parser.parse_args()

    if args.auth_token:
        AUTH_TOKEN = args.auth_token

    SoulHandler.storage = SoulStorage(SOUL_DIR)

    server = HTTPServer((args.host, args.port), SoulHandler)
    print(f"Elitza Soul Container running on {args.host}:{args.port}")
    print(f"Data directory: {SOUL_DIR}")
    print(f"Auth: {'enabled' if AUTH_TOKEN else 'disabled'}")
    print(f"Endpoints:")
    print(f"  GET  /state      — Get full soul state")
    print(f"  POST /state      — Save soul state")
    print(f"  GET  /version    — Get current version")
    print(f"  GET  /journal    — Get transition journal")
    print(f"  POST /journal    — Add journal entry")
    print(f"  GET  /files      — List all files")
    print(f"  GET  /file/<path> — Get a file")
    print(f"  PUT  /file/<path> — Save a file")
    print(f"  GET  /health     — Health check")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
