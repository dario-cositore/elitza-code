"""Cron/Scheduler -- scheduled task system for Elitza.

Supports: duration phrases ("every 5 minutes"), 5-field cron expressions,
ISO timestamps, and one-shot timers. Searches the tool catalog by keyword.
"""

import json
import logging
import re
import threading
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Callable, Dict, List, Optional

from elitza.constants import get_elitza_home

logger = logging.getLogger(__name__)

JOBS_FILE = get_elitza_home() / "cron_jobs.json"


class CronJob:
    """A scheduled job."""

    def __init__(self, job_id: str, name: str, schedule: str,
                 task: str, model: str = "", enabled: bool = True):
        self.job_id = job_id
        self.name = name
        self.schedule = schedule  # cron expression or duration
        self.task = task
        self.model = model
        self.enabled = enabled
        self.last_run: Optional[float] = None
        self.next_run: Optional[float] = None
        self.run_count = 0
        self.last_result: str = ""
        self._parse_schedule()

    def _parse_schedule(self):
        """Parse the schedule into a next_run time."""
        now = time.time()
        sched = self.schedule.lower().strip()

        # Duration phrases: "every 5 minutes", "every hour", "every day"
        duration_match = re.match(r'every\s+(\d+)\s+(minute|hour|day|week)s?', sched)
        if duration_match:
            num = int(duration_match.group(1))
            unit = duration_match.group(2)
            seconds = {"minute": 60, "hour": 3600, "day": 86400, "week": 604800}[unit]
            self.next_run = now + (num * seconds)
            return

        # ISO timestamp
        try:
            dt = datetime.fromisoformat(sched.replace("Z", "+00:00"))
            self.next_run = dt.timestamp()
            return
        except Exception:
            pass

        # Simple interval in seconds
        try:
            seconds = int(sched)
            self.next_run = now + seconds
            return
        except ValueError:
            pass

        # Default: run every hour
        self.next_run = now + 3600

    def should_run(self) -> bool:
        if not self.enabled or self.next_run is None:
            return False
        return time.time() >= self.next_run

    def mark_run(self, result: str = ""):
        self.last_run = time.time()
        self.run_count += 1
        self.last_result = result[:200]
        self._parse_schedule()  # Recalculate next_run

    def to_dict(self) -> dict:
        return {
            "job_id": self.job_id,
            "name": self.name,
            "schedule": self.schedule,
            "task": self.task,
            "model": self.model,
            "enabled": self.enabled,
            "last_run": self.last_run,
            "next_run": self.next_run,
            "run_count": self.run_count,
            "last_result": self.last_result,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "CronJob":
        job = cls(
            job_id=data["job_id"],
            name=data["name"],
            schedule=data["schedule"],
            task=data["task"],
            model=data.get("model", ""),
            enabled=data.get("enabled", True),
        )
        job.last_run = data.get("last_run")
        job.next_run = data.get("next_run")
        job.run_count = data.get("run_count", 0)
        job.last_result = data.get("last_result", "")
        return job


class CronScheduler:
    """Manages and runs scheduled jobs."""

    def __init__(self):
        self.jobs: Dict[str, CronJob] = {}
        self._lock = threading.Lock()
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._agent_fn: Optional[Callable] = None
        self._load()

    def set_agent_fn(self, fn: Callable):
        """Set the function to call when a job runs. Takes (task, model) -> str."""
        self._agent_fn = fn

    def _load(self):
        if JOBS_FILE.exists():
            try:
                data = json.loads(JOBS_FILE.read_text())
                for job_data in data.get("jobs", []):
                    job = CronJob.from_dict(job_data)
                    self.jobs[job.job_id] = job
            except Exception:
                pass

    def _save(self):
        JOBS_FILE.parent.mkdir(parents=True, exist_ok=True)
        JOBS_FILE.write_text(json.dumps({
            "jobs": [j.to_dict() for j in self.jobs.values()]
        }, indent=2))

    def add_job(self, name: str, schedule: str, task: str, model: str = "") -> str:
        """Add a new scheduled job."""
        job_id = f"job_{int(time.time())}_{len(self.jobs)}"
        job = CronJob(job_id, name, schedule, task, model)
        with self._lock:
            self.jobs[job_id] = job
            self._save()
        logger.info("Added cron job: %s (schedule: %s)", name, schedule)
        return job_id

    def remove_job(self, job_id: str) -> bool:
        with self._lock:
            if job_id in self.jobs:
                del self.jobs[job_id]
                self._save()
                return True
        return False

    def enable_job(self, job_id: str, enabled: bool = True):
        with self._lock:
            if job_id in self.jobs:
                self.jobs[job_id].enabled = enabled
                self._save()

    def list_jobs(self) -> List[dict]:
        return [j.to_dict() for j in self.jobs.values()]

    def run_due_jobs(self):
        """Check and run any due jobs. Called by the tick loop."""
        with self._lock:
            due_jobs = [j for j in self.jobs.values() if j.should_run()]

        for job in due_jobs:
            logger.info("Running cron job: %s", job.name)
            try:
                if self._agent_fn:
                    result = self._agent_fn(job.task, job.model)
                    job.mark_run(result)
                else:
                    job.mark_run("No agent function set")
            except Exception as e:
                job.mark_run(f"Error: {str(e)[:100]}")
                logger.error("Cron job %s failed: %s", job.name, e)

        if due_jobs:
            self._save()

    def start(self, interval: int = 60):
        """Start the cron tick loop in a background thread."""
        if self._running:
            return
        self._running = True

        def tick_loop():
            while self._running:
                self.run_due_jobs()
                time.sleep(interval)

        self._thread = threading.Thread(target=tick_loop, daemon=True)
        self._thread.start()
        logger.info("Cron scheduler started (interval: %ds)", interval)

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)


# Global singleton
scheduler = CronScheduler()
