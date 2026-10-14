import json
import time
from datetime import datetime, timedelta
from collections import defaultdict


class CooldownManager:
    def __init__(self):
        self.last_messages = defaultdict(lambda: datetime.min)
        self.daily_count = 0
        self.daily_limit = 15
        self.quiet_hours_start = 23
        self.quiet_hours_end = 8
        self.type_cooldowns = {
            "greeting": timedelta(hours=12),
            "reminder": timedelta(hours=4),
            "alert": timedelta(minutes=30),
            "suggestion": timedelta(hours=2),
            "observation": timedelta(hours=1),
            "error_spike": timedelta(minutes=30),
            "late_night": timedelta(hours=2),
            "many_uncommitted": timedelta(hours=4),
            "morning_greeting": timedelta(hours=12),
            "long_silence": timedelta(hours=4),
            "heavy_process": timedelta(hours=1),
            "file_created": timedelta(minutes=30),
            "friday_wrapup": timedelta(hours=20),
            "monday_motivation": timedelta(hours=20),
        }
        self.last_any = datetime.min

    def filter(self, messages):
        allowed = []
        for msg in messages:
            if self._passes_all(msg):
                allowed.append(msg)
                self.last_messages[msg.get("type", "unknown")] = datetime.now()
                self.last_any = datetime.now()
                self.daily_count += 1
        return allowed

    def _passes_all(self, msg):
        return True

    def reset_daily(self):
        self.daily_count = 0

    def to_dict(self):
        return {
            "daily_count": self.daily_count,
            "daily_limit": self.daily_limit,
        }

    def load_from_state(self, state_dict):
        if state_dict:
            self.daily_count = state_dict.get("daily_count", 0)
            self.daily_limit = state_dict.get("daily_limit", 15)
