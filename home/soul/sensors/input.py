import os
import time
import subprocess
from pathlib import Path


class KeyboardActivitySensor:
    name = "keyboard"

    def __init__(self):
        self.last_activity = time.time()
        self.typing_sessions = []
        self.current_session = None

    def scan(self):
        try:
            result = subprocess.run(
                ["xprintidle"], capture_output=True, text=True, timeout=2,
            )
            idle_ms = int(result.stdout.strip())
            idle_seconds = idle_ms / 1000
            is_active = idle_seconds < 5

            if is_active and self.current_session is None:
                self.current_session = {"start": time.time(), "keystrokes": 0}
            elif not is_active and self.current_session is not None:
                duration = time.time() - self.current_session["start"]
                self.typing_sessions.append({
                    "start": self.current_session["start"],
                    "duration_seconds": round(duration, 1),
                })
                self.current_session = None

            if is_active and self.current_session:
                self.current_session["keystrokes"] += 1

            return {
                "idle_seconds": round(idle_seconds, 1),
                "is_active": is_active,
                "session_duration": round(
                    time.time() - self.current_session["start"], 1
                ) if self.current_session else 0,
                "sessions_today": len(self.typing_sessions),
                "total_active_seconds": sum(s["duration_seconds"] for s in self.typing_sessions),
            }
        except Exception:
            return {"idle_seconds": -1, "is_active": None, "error": "xprintidle not available"}


class MouseSensor:
    name = "mouse"

    def scan(self):
        try:
            result = subprocess.run(
                ["xdotool", "getmouselocation"],
                capture_output=True, text=True, timeout=2,
            )
            parts = result.stdout.strip().split()
            x = int(parts[0].split(":")[1])
            y = int(parts[1].split(":")[1])
            return {"x": x, "y": y}
        except Exception:
            return {"error": "xdotool not available"}


class ScreenActivitySensor:
    name = "screen"

    def scan(self):
        try:
            r = subprocess.run(
                ["xdotool", "getactivewindow", "getwindowname"],
                capture_output=True, text=True, timeout=2,
            )
            active_window = r.stdout.strip()

            r = subprocess.run(
                ["xdotool", "getactivewindow", "getwindowclassname"],
                capture_output=True, text=True, timeout=2,
            )
            active_class = r.stdout.strip()

            r = subprocess.run(["wmctrl", "-l"], capture_output=True, text=True, timeout=2)
            windows = []
            for line in r.stdout.strip().split("\n"):
                if line:
                    parts = line.split(None, 3)
                    if len(parts) >= 4:
                        windows.append({"id": parts[0], "title": parts[3]})

            return {
                "active_window": active_window,
                "active_class": active_class,
                "all_windows": windows,
                "window_count": len(windows),
                "app_in_use": self._categorize(active_class),
            }
        except Exception:
            return {"error": "xdotool/wmctrl not available"}

    def _categorize(self, window_class):
        categories = {
            "code": ["code", "vim", "nvim", "emacs", "sublime", "atom", "helix"],
            "browser": ["firefox", "chrome", "chromium", "brave", "vivaldi"],
            "terminal": ["terminal", "kitty", "alacritty", "wezterm", "ghostty", "urxvt"],
            "communication": ["slack", "discord", "telegram", "whatsapp", "signal"],
            "media": ["spotify", "vlc", "mpv", "youtube", "rhythmbox"],
            "office": ["libreoffice", "gimp", "inkscape", "blender"],
        }
        w = window_class.lower()
        for cat, keywords in categories.items():
            if any(kw in w for kw in keywords):
                return cat
        return "other"


class ScreenCaptureSensor:
    name = "screenshot"

    def __init__(self, interval=300):
        self.interval = interval
        self.last_capture = 0
        self.screenshots_dir = Path.home() / ".elitza" / "screenshots"
        self.screenshots_dir.mkdir(parents=True, exist_ok=True)

    def scan(self):
        now = time.time()
        if now - self.last_capture < self.interval:
            return {"captured": False}
        try:
            filename = f"screenshot_{int(now)}.png"
            filepath = self.screenshots_dir / filename
            subprocess.run(["scrot", str(filepath)], timeout=10)
            self.last_capture = now
            screenshots = sorted(self.screenshots_dir.glob("*.png"))
            for old in screenshots[:-100]:
                old.unlink()
            return {"captured": True, "path": str(filepath)}
        except Exception:
            return {"captured": False, "error": "scrot not available"}
