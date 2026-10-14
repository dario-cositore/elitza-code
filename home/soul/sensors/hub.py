import json
import time
from pathlib import Path
from datetime import datetime
from collections import defaultdict

from soul.sensors.core import (
    CPUMemorySensor, DiskSensor, NetworkSensor,
    ProcessSensor, TemperatureSensor, BatterySensor,
)
from soul.sensors.filesystem import FileChangeSensor, ClipboardSensor, GitSensor
from soul.sensors.input import (
    KeyboardActivitySensor, MouseSensor,
    ScreenActivitySensor, ScreenCaptureSensor,
)
from soul.sensors.applications import (
    BrowserSensor, EmailSensor, MusicSensor,
    NotificationSensor, DockerSensor, SystemdSensor,
)
from soul.sensors.advanced import (
    USBSensor, BluetoothSensor, AudioSensor,
    LocationSensor, WeatherSensor,
)


class AnomalyDetector:
    def detect(self, current, history):
        anomalies = []
        if not history:
            return anomalies
        prev = history[-1].get("model", {})

        cpu_now = current.get("system", {}).get("cpu", 0)
        cpu_prev = prev.get("system", {}).get("cpu", 0)
        if cpu_now > 90 and cpu_prev < 50:
            anomalies.append({
                "type": "cpu_spike",
                "severity": "warning",
                "detail": f"CPU {cpu_prev}% -> {cpu_now}%",
            })

        recent_mem = [h.get("model", {}).get("system", {}).get("memory_percent", 0) for h in history[-10:]]
        if len(recent_mem) >= 5 and all(recent_mem[i] < recent_mem[i + 1] for i in range(len(recent_mem) - 1)):
            anomalies.append({
                "type": "memory_trend",
                "severity": "warning",
                "detail": "Memory steadily increasing",
            })

        if current.get("system", {}).get("disk_critical"):
            anomalies.append({"type": "disk_critical", "severity": "critical"})

        if current.get("health", {}).get("zombies"):
            anomalies.append({
                "type": "zombie_processes",
                "severity": "warning",
                "detail": f"{len(current['health']['zombies'])} zombies",
            })

        return anomalies


class SensorHub:
    SLOW_SENSORS = {"bluetooth", "screenshot", "browser"}

    def __init__(self):
        self.sensors = {
            "cpu_memory": CPUMemorySensor(),
            "disk": DiskSensor(),
            "network": NetworkSensor(),
            "process": ProcessSensor(),
            "temperature": TemperatureSensor(),
            "battery": BatterySensor(),
            "file_changes": FileChangeSensor(),
            "clipboard": ClipboardSensor(),
            "git": GitSensor(),
            "keyboard": KeyboardActivitySensor(),
            "mouse": MouseSensor(),
            "screen": ScreenActivitySensor(),
            "screenshot": ScreenCaptureSensor(),
            "browser": BrowserSensor(),
            "email": EmailSensor(),
            "music": MusicSensor(),
            "notifications": NotificationSensor(),
            "docker": DockerSensor(),
            "systemd": SystemdSensor(),
            "usb": USBSensor(),
            "bluetooth": BluetoothSensor(),
            "audio": AudioSensor(),
            "location": LocationSensor(),
            "weather": WeatherSensor(),
        }
        self.world_model = {}
        self.scan_history = []
        self.anomaly_detector = AnomalyDetector()
        self._last_full_scan = 0
        self._cached_world = {}
        self._cache_ttl = 30  # Cache for 30 seconds

    def start_background_sensors(self):
        fs = self.sensors.get("file_changes")
        if fs and hasattr(fs, "start"):
            try:
                fs.start([str(Path.home()), str(Path.cwd())])
            except Exception:
                pass

    def scan_fast(self):
        """Fast scan — skip slow sensors. Used for real-time responses."""
        import time
        now = time.time()
        if now - self._last_full_scan < self._cache_ttl and self._cached_world:
            return self._cached_world

        results = {}
        for name, sensor in self.sensors.items():
            if name in self.SLOW_SENSORS:
                continue
            try:
                results[name] = sensor.scan()
            except Exception:
                results[name] = {"error": "scan failed"}

        world = self._build_world_model(results)
        self._cached_world = world
        self._last_full_scan = now
        return world

    def scan_all(self):
        """Full scan of all sensors."""
        results = {}
        for name, sensor in self.sensors.items():
            try:
                results[name] = sensor.scan()
            except Exception as e:
                results[name] = {"error": str(e)}

        self.world_model = self._build_world_model(results)
        anomalies = self.anomaly_detector.detect(self.world_model, self.scan_history)
        self.world_model["anomalies"] = anomalies

        self.scan_history.append({
            "timestamp": datetime.now().isoformat(),
            "model": self.world_model,
        })
        self.scan_history = self.scan_history[-500:]
        return self.world_model

    def _build_world_model(self, r):
        return {
            "timestamp": datetime.now().isoformat(),
            "system": {
                "cpu": r.get("cpu_memory", {}).get("cpu_percent", 0),
                "memory_percent": r.get("cpu_memory", {}).get("memory_percent", 0),
                "disk_critical": r.get("disk", {}).get("critical", False),
                "overheating": r.get("temperature", {}).get("overheating", False),
                "battery_low": r.get("battery", {}).get("low", False),
            },
            "user": {
                "active": r.get("keyboard", {}).get("is_active", False),
                "idle_seconds": r.get("keyboard", {}).get("idle_seconds", 0),
                "app_in_use": r.get("screen", {}).get("app_in_use", "unknown"),
                "active_window": r.get("screen", {}).get("active_window", ""),
                "audio_playing": r.get("audio", {}).get("audio_playing", False),
            },
            "files": {
                "recent_changes": r.get("file_changes", {}).get("total_changes", 0),
                "clipboard_changed": r.get("clipboard", {}).get("changed", False),
            },
            "code": {
                "git_dirty": r.get("git", {}).get("dirty", False),
                "uncommitted": r.get("git", {}).get("uncommitted", 0),
                "conflicts": r.get("git", {}).get("conflicts", 0),
                "branch": r.get("git", {}).get("branch", ""),
                "hours_since_commit": r.get("git", {}).get("hours_since_last_commit", 0),
            },
            "network": {
                "connections": r.get("network", {}).get("active_connections", 0),
                "new_connections": r.get("network", {}).get("new_connections", []),
            },
            "environment": {
                "weather": r.get("weather", {}).get("description", "unknown"),
                "temp": r.get("weather", {}).get("temp_c", "unknown"),
                "location": r.get("location", {}).get("city", "unknown"),
                "time_of_day": self._time_category(),
            },
            "health": {
                "system_errors": r.get("systemd", {}).get("has_failures", False),
                "failed_services": r.get("systemd", {}).get("failed_units", []),
                "processes": r.get("process", {}).get("total_processes", 0),
                "zombies": r.get("process", {}).get("zombies", []),
                "docker_unhealthy": sum(
                    1 for c in r.get("docker", {}).get("containers", [])
                    if not c.get("running", True)
                ),
            },
            "anomalies": [],
            "_raw": r,
        }

    def _time_category(self):
        h = datetime.now().hour
        if 5 <= h < 12:
            return "morning"
        elif 12 <= h < 17:
            return "afternoon"
        elif 17 <= h < 21:
            return "evening"
        return "night"

    def query(self, question):
        m = self.world_model
        q = question.lower()
        if "user doing" in q:
            u = m.get("user", {})
            if u.get("active"):
                return f"Active. Using {u.get('app_in_use', '?')}."
            return f"Idle for {u.get('idle_seconds', 0)} seconds."
        if "files changed" in q:
            return f"{m.get('files', {}).get('recent_changes', 0)} files changed."
        if "git" in q or "code" in q:
            c = m.get("code", {})
            return f"Branch: {c.get('branch', '?')}. {c.get('uncommitted', 0)} uncommitted."
        if "health" in q or "wrong" in q:
            h = m.get("health", {})
            issues = []
            if h.get("system_errors"):
                issues.append("system errors")
            if h.get("zombies"):
                issues.append(f"{len(h['zombies'])} zombies")
            return "Issues: " + ", ".join(issues) if issues else "Healthy."
        if "weather" in q:
            e = m.get("environment", {})
            return f"{e.get('weather', '?')} at {e.get('temp', '?')}C."
        return json.dumps(m, indent=2)[:2000]
