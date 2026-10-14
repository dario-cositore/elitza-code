import os
import time
import psutil
from pathlib import Path


class CPUMemorySensor:
    name = "cpu_memory"

    def scan(self):
        cpu_percent = psutil.cpu_percent(interval=0.5)
        mem = psutil.virtual_memory()
        swap = psutil.swap_memory()
        return {
            "cpu_percent": cpu_percent,
            "cpu_count": psutil.cpu_count(),
            "memory_used_gb": round(mem.used / (1024**3), 2),
            "memory_total_gb": round(mem.total / (1024**3), 2),
            "memory_percent": mem.percent,
            "swap_used_gb": round(swap.used / (1024**3), 2),
            "load_avg": os.getloadavg(),
        }


class DiskSensor:
    name = "disk"

    def scan(self):
        disks = []
        for part in psutil.disk_partitions():
            try:
                usage = psutil.disk_usage(part.mountpoint)
                disks.append({
                    "device": part.device,
                    "mount": part.mountpoint,
                    "total_gb": round(usage.total / (1024**3), 2),
                    "used_gb": round(usage.used / (1024**3), 2),
                    "percent": usage.percent,
                })
            except PermissionError:
                pass
        io = psutil.disk_io_counters()
        return {
            "partitions": disks,
            "io_read_mb": round(io.read_bytes / (1024**2), 2) if io else 0,
            "io_write_mb": round(io.write_bytes / (1024**2), 2) if io else 0,
            "critical": any(d["percent"] > 90 for d in disks),
        }


class NetworkSensor:
    name = "network"

    def __init__(self):
        self.known_connections = set()

    def scan(self):
        connections = psutil.net_connections(kind="inet")
        active = []
        new_connections = []
        for conn in connections:
            if conn.status == "ESTABLISHED":
                info = {
                    "local": f"{conn.laddr.ip}:{conn.laddr.port}" if conn.laddr else "?",
                    "remote": f"{conn.raddr.ip}:{conn.raddr.port}" if conn.raddr else "?",
                    "pid": conn.pid,
                    "process": self._get_process_name(conn.pid),
                }
                active.append(info)
                conn_key = f"{info['local']}->{info['remote']}"
                if conn_key not in self.known_connections:
                    new_connections.append(info)
                    self.known_connections.add(conn_key)
        io = psutil.net_io_counters()
        return {
            "active_connections": len(active),
            "connections": active[:20],
            "new_connections": new_connections,
            "bytes_sent_mb": round(io.bytes_sent / (1024**2), 2),
            "bytes_recv_mb": round(io.bytes_recv / (1024**2), 2),
        }

    def _get_process_name(self, pid):
        try:
            return psutil.Process(pid).name()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return "unknown"


class ProcessSensor:
    name = "process"

    def __init__(self):
        self.known_pids = set()

    def scan(self):
        current_pids = set()
        processes = []
        new_processes = []
        dead_processes = []

        for proc in psutil.process_iter(
            ["pid", "name", "cpu_percent", "memory_percent", "status", "create_time", "cmdline"]
        ):
            try:
                info = proc.info
                pid = info["pid"]
                current_pids.add(pid)
                process_info = {
                    "pid": pid,
                    "name": info["name"],
                    "cpu_percent": info["cpu_percent"],
                    "memory_percent": round(info["memory_percent"] or 0, 2),
                    "status": info["status"],
                    "uptime": time.time() - info["create_time"] if info["create_time"] else 0,
                    "cmdline": " ".join(info["cmdline"][:3]) if info["cmdline"] else "",
                }
                processes.append(process_info)
                if pid not in self.known_pids:
                    new_processes.append(process_info)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass

        for pid in self.known_pids - current_pids:
            dead_processes.append(pid)
        self.known_pids = current_pids

        top_cpu = sorted(processes, key=lambda p: p["cpu_percent"] or 0, reverse=True)[:5]
        top_mem = sorted(processes, key=lambda p: p["memory_percent"] or 0, reverse=True)[:5]

        return {
            "total_processes": len(processes),
            "new_processes": new_processes,
            "dead_processes": dead_processes,
            "top_cpu": top_cpu,
            "top_memory": top_mem,
            "zombies": [p for p in processes if p["status"] == "zombie"],
        }


class TemperatureSensor:
    name = "temperature"

    def scan(self):
        temps = {}
        try:
            for name, entries in psutil.sensors_temperatures().items():
                for entry in entries:
                    label = entry.label or "core"
                    temps[f"{name}_{label}"] = {
                        "current": entry.current,
                        "high": entry.high,
                        "critical": entry.critical,
                    }
        except (AttributeError, Exception):
            pass
        return {
            "sensors": temps,
            "overheating": any(
                v["current"] > (v.get("critical") or 100) * 0.9
                for v in temps.values()
            ) if temps else False,
        }


class BatterySensor:
    name = "battery"

    def scan(self):
        battery = psutil.sensors_battery()
        if not battery:
            return {"present": False}
        return {
            "present": True,
            "percent": battery.percent,
            "plugged": battery.power_plugged,
            "time_left": battery.secsleft if battery.secsleft > 0 else None,
            "low": battery.percent < 20,
            "critical": battery.percent < 10,
        }
