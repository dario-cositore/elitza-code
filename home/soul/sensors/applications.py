import os
import json
import subprocess
from pathlib import Path
from datetime import datetime


class BrowserSensor:
    name = "browser"

    def scan(self):
        history = []
        firefox_path = Path.home() / ".mozilla" / "firefox"
        if firefox_path.exists():
            for profile in firefox_path.iterdir():
                places = profile / "places.sqlite"
                if places.exists():
                    try:
                        import sqlite3
                        conn = sqlite3.connect(f"file:{places}?mode=ro", uri=True)
                        cursor = conn.execute(
                            "SELECT url, title, last_visit_date "
                            "FROM moz_places ORDER BY last_visit_date DESC LIMIT 10"
                        )
                        for row in cursor:
                            history.append({
                                "browser": "firefox",
                                "url": row[0],
                                "title": row[1],
                            })
                        conn.close()
                    except Exception:
                        pass
        return {"recent_history": history[:20]}


class EmailSensor:
    name = "email"

    def scan(self):
        emails = []
        mailbox_paths = [
            Path.home() / "Maildir" / "new",
            Path.home() / "mail" / "new",
        ]
        for mailbox in mailbox_paths:
            if mailbox.exists():
                new_emails = list(mailbox.iterdir())
                emails.extend([{"file": str(e)} for e in new_emails])
        return {"unread_count": len(emails)}


class MusicSensor:
    name = "music"

    def scan(self):
        try:
            r = subprocess.run(["mpc", "current"], capture_output=True, text=True, timeout=2)
            if r.stdout.strip():
                return {"playing": True, "source": "mpd", "track": r.stdout.strip()}
            return {"playing": False}
        except Exception:
            return {"playing": False}


class NotificationSensor:
    name = "notifications"

    def __init__(self):
        self.notifications = []

    def scan(self):
        try:
            r = subprocess.run(
                ["dunstctl", "history"], capture_output=True, text=True, timeout=2,
            )
            if r.stdout:
                data = json.loads(r.stdout)
                new = data.get("data", [])
                self.notifications.extend(new)
                return {"recent": new[-5:], "total_today": len(self.notifications)}
        except Exception:
            pass
        return {"recent": [], "total_today": 0}


class DockerSensor:
    name = "docker"

    def scan(self):
        try:
            r = subprocess.run(
                ["docker", "ps", "-a", "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}"],
                capture_output=True, text=True, timeout=5,
            )
            containers = []
            for line in r.stdout.strip().split("\n"):
                if line:
                    parts = line.split("\t")
                    if len(parts) >= 3:
                        containers.append({
                            "name": parts[0],
                            "status": parts[1],
                            "image": parts[2],
                            "running": "Up" in parts[1],
                        })
            return {
                "total": len(containers),
                "running": sum(1 for c in containers if c["running"]),
                "containers": containers,
            }
        except Exception:
            return {"error": "docker not available"}


class SystemdSensor:
    name = "systemd"

    def scan(self):
        try:
            r = subprocess.run(
                ["systemctl", "--failed", "--no-pager", "--no-legend"],
                capture_output=True, text=True, timeout=5,
            )
            failed = []
            for line in r.stdout.strip().split("\n"):
                if line and line.split():
                    failed.append(line.split()[0])

            r = subprocess.run(
                ["journalctl", "--since", "1 hour ago", "--no-pager", "-q", "-n", "20"],
                capture_output=True, text=True, timeout=5,
            )
            recent_logs = r.stdout.strip().split("\n") if r.stdout.strip() else []

            return {
                "failed_units": failed,
                "has_failures": len(failed) > 0,
                "recent_logs": recent_logs[-10:],
            }
        except Exception:
            return {"error": "systemctl not available"}
