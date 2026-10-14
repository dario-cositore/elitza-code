import json
import time
from pathlib import Path
from datetime import datetime


class DaemonState:
    def __init__(self):
        self.state_file = Path.home() / ".elitza" / "soul" / "daemon_state.json"
        self.last_run = None
        self.messages_today = 0
        self.max_messages_per_day = 50
        self.quiet_hours = False
        self.quiet_start = 23
        self.quiet_end = 8
        self.speaking_threshold = 0.3
        self.total_messages_sent = 0
        self.last_date = None
        self.cooldown_state = {}
        self.telegram_chat_id = None
        self.load()

    def load(self):
        if self.state_file.exists():
            try:
                data = json.loads(self.state_file.read_text())
                self.last_run = data.get("last_run")
                self.messages_today = data.get("messages_today", 0)
                self.quiet_start = data.get("quiet_start", 23)
                self.quiet_end = data.get("quiet_end", 8)
                self.speaking_threshold = data.get("speaking_threshold", 0.3)
                self.total_messages_sent = data.get("total_messages_sent", 0)
                self.last_date = data.get("last_date")
                self.cooldown_state = data.get("cooldown_state", {})
                self.telegram_chat_id = data.get("telegram_chat_id")
            except Exception:
                pass

        today = datetime.now().strftime("%Y-%m-%d")
        if self.last_date != today:
            self.messages_today = 0
            self.last_date = today

    def save(self):
        self.last_run = datetime.now().isoformat()
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "last_run": self.last_run,
            "messages_today": self.messages_today,
            "max_messages_per_day": self.max_messages_per_day,
            "quiet_hours": self.quiet_hours,
            "quiet_start": self.quiet_start,
            "speaking_threshold": self.speaking_threshold,
            "total_messages_sent": self.total_messages_sent,
            "last_date": self.last_date,
            "cooldown_state": self.cooldown_state,
            "telegram_chat_id": self.telegram_chat_id,
        }
        self.state_file.write_text(json.dumps(data, indent=2))

    def increment_messages(self):
        self.messages_today += 1
        self.total_messages_sent += 1
