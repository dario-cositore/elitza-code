import json
import subprocess
import time
from pathlib import Path


class USBSensor:
    name = "usb"

    def __init__(self):
        self.known_devices = set()

    def scan(self):
        try:
            r = subprocess.run(["lsusb"], capture_output=True, text=True, timeout=2)
            current = set()
            devices = []
            for line in r.stdout.strip().split("\n"):
                if line:
                    current.add(line)
                    devices.append(line)
            new = current - self.known_devices
            removed = self.known_devices - current
            self.known_devices = current
            return {
                "total": len(devices),
                "devices": devices,
                "new": list(new),
                "removed": list(removed),
                "changed": bool(new or removed),
            }
        except Exception:
            return {"error": "lsusb not available"}


class BluetoothSensor:
    name = "bluetooth"

    def scan(self):
        try:
            r = subprocess.run(
                ["bluetoothctl", "devices"],
                capture_output=True, text=True, timeout=5,
            )
            devices = []
            for line in r.stdout.strip().split("\n"):
                if line and "Device" in line:
                    parts = line.split(" ", 2)
                    if len(parts) >= 3:
                        devices.append({"mac": parts[1], "name": parts[2]})
            return {"paired_devices": len(devices), "devices": devices}
        except Exception:
            return {"error": "bluetoothctl not available"}


class AudioSensor:
    name = "audio"

    def scan(self):
        try:
            r = subprocess.run(
                ["pactl", "list", "sinks", "short"],
                capture_output=True, text=True, timeout=2,
            )
            sinks = []
            for line in r.stdout.strip().split("\n"):
                if line:
                    parts = line.split()
                    if len(parts) >= 3:
                        sinks.append({
                            "name": parts[1],
                            "running": parts[2] == "RUNNING",
                        })

            r = subprocess.run(
                ["pactl", "list", "sources", "short"],
                capture_output=True, text=True, timeout=2,
            )
            sources = []
            for line in r.stdout.strip().split("\n"):
                if line:
                    parts = line.split()
                    if len(parts) >= 3:
                        sources.append({
                            "name": parts[1],
                            "active": parts[2] == "RUNNING",
                        })

            return {
                "audio_playing": any(s["running"] for s in sinks),
                "mic_active": any(s["active"] for s in sources),
            }
        except Exception:
            return {"error": "pactl not available"}


class LocationSensor:
    name = "location"

    def scan(self):
        try:
            import urllib.request
            req = urllib.request.Request(
                "http://ip-api.com/json/?fields=status,country,city,lat,lon,timezone",
                headers={"User-Agent": "Elitza/1.0"},
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode())
                return {
                    "country": data.get("country"),
                    "city": data.get("city"),
                    "timezone": data.get("timezone"),
                    "lat": data.get("lat"),
                    "lon": data.get("lon"),
                }
        except Exception:
            return {"error": "location unavailable"}


class WeatherSensor:
    name = "weather"

    def scan(self):
        try:
            import urllib.request
            req = urllib.request.Request(
                "https://wttr.in/?format=j1",
                headers={"User-Agent": "Elitza/1.0"},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode())
                current = data.get("current_condition", [{}])[0]
                return {
                    "temp_c": current.get("temp_C"),
                    "temp_f": current.get("temp_F"),
                    "description": current.get("weatherDesc", [{}])[0].get("value"),
                    "humidity": current.get("humidity"),
                    "wind_kph": current.get("windspeedKmph"),
                }
        except Exception:
            return {"error": "weather unavailable"}
