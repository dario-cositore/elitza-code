import os
import time
import subprocess
from pathlib import Path
from collections import defaultdict

try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler
    HAS_WATCHDOG = True
except ImportError:
    HAS_WATCHDOG = False


class FileChangeSensor:
    name = "file_changes"

    def __init__(self):
        self.changes = []
        self.observer = None
        self.change_stats = defaultdict(int)

    def start(self, paths=None):
        if not HAS_WATCHDOG:
            return
        if not paths:
            paths = [os.getcwd(), str(Path.home() / ".elitza")]
        handler = self._create_handler()
        self.observer = Observer()
        for path in paths:
            if os.path.exists(path):
                try:
                    self.observer.schedule(handler, path, recursive=True)
                except Exception:
                    pass
        self.observer.daemon = True
        self.observer.start()

    def stop(self):
        if self.observer:
            self.observer.stop()
            self.observer.join(timeout=2)

    def scan(self):
        recent = self.changes[-50:]
        self.changes = self.changes[-50:]
        by_type = defaultdict(list)
        for change in recent:
            by_type[change["type"]].append(change)
        return {
            "total_changes": len(recent),
            "by_type": {k: len(v) for k, v in by_type.items()},
            "recent": recent[-10:],
            "watching": self.observer is not None and self.observer.is_alive(),
        }

    def _create_handler(self):
        sensor = self

        class Handler(FileSystemEventHandler):
            def on_modified(self, event):
                if not event.is_directory:
                    sensor._record("modified", event.src_path)

            def on_created(self, event):
                if not event.is_directory:
                    sensor._record("created", event.src_path)

            def on_deleted(self, event):
                if not event.is_directory:
                    sensor._record("deleted", event.src_path)

            def on_moved(self, event):
                if not event.is_directory:
                    sensor._record("moved", event.src_path, event.dest_path)

        return Handler()

    def _record(self, change_type, src, dest=None):
        entry = {
            "type": change_type,
            "path": src,
            "dest": dest,
            "timestamp": time.time(),
        }
        self.changes.append(entry)
        self.change_stats[os.path.dirname(src)] += 1


class ClipboardSensor:
    name = "clipboard"

    def __init__(self):
        self.last_content = ""
        self.history = []

    def scan(self):
        try:
            result = subprocess.run(
                ["xclip", "-selection", "clipboard", "-o"],
                capture_output=True, text=True, timeout=2,
            )
            current = result.stdout
            if current and current != self.last_content:
                self.history.append({
                    "content": current[:500],
                    "length": len(current),
                    "timestamp": time.time(),
                    "type": self._classify(current),
                })
                self.last_content = current
                if len(self.history) > 100:
                    self.history = self.history[-100:]
                return {"changed": True, "content": current[:200]}
            return {"changed": False}
        except Exception:
            return {"changed": False, "error": "xclip not available"}

    def _classify(self, content):
        if content.startswith(("http://", "https://")):
            return "url"
        if "@" in content and "." in content:
            return "email"
        s = content.strip()
        if s.startswith(("{", "[")):
            return "json"
        if s.startswith("/"):
            return "path"
        if any(kw in content for kw in ("import ", "def ", "class ", "function ")):
            return "code"
        return "text"


class GitSensor:
    name = "git"

    def scan(self):
        try:
            r = subprocess.run(["git", "status", "--porcelain"], capture_output=True, text=True, timeout=5)
            uncommitted = len(r.stdout.strip().split("\n")) if r.stdout.strip() else 0

            r = subprocess.run(["git", "branch", "--show-current"], capture_output=True, text=True, timeout=5)
            branch = r.stdout.strip()

            r = subprocess.run(
                ["git", "log", "--oneline", "-10", "--format=%h %s (%ar)"],
                capture_output=True, text=True, timeout=5,
            )
            commits = r.stdout.strip().split("\n") if r.stdout.strip() else []

            r = subprocess.run(["git", "stash", "list"], capture_output=True, text=True, timeout=5)
            stashes = len(r.stdout.strip().split("\n")) if r.stdout.strip() else 0

            r = subprocess.run(
                ["git", "ls-files", "--others", "--exclude-standard"],
                capture_output=True, text=True, timeout=5,
            )
            untracked = len(r.stdout.strip().split("\n")) if r.stdout.strip() else 0

            r = subprocess.run(
                ["git", "diff", "--name-only", "--diff-filter=U"],
                capture_output=True, text=True, timeout=5,
            )
            conflicts = len(r.stdout.strip().split("\n")) if r.stdout.strip() else 0

            r = subprocess.run(["git", "log", "-1", "--format=%at"], capture_output=True, text=True, timeout=5)
            last_ts = int(r.stdout.strip()) if r.stdout.strip() else 0
            hours_since = (time.time() - last_ts) / 3600 if last_ts else 999

            return {
                "branch": branch,
                "uncommitted": uncommitted,
                "untracked": untracked,
                "stashes": stashes,
                "conflicts": conflicts,
                "recent_commits": commits,
                "hours_since_last_commit": round(hours_since, 1),
                "dirty": uncommitted > 0,
            }
        except Exception:
            return {"error": "not a git repo"}
