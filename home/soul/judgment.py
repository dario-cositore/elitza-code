import json
from datetime import datetime


class MessageTemplates:
    def morning(self, event=None):
        h = datetime.now().hour
        if h < 10:
            return "Good morning. Ready when you are."
        elif h < 12:
            return "Morning. What are we working on today?"
        return "Hey. What's the plan?"

    def long_absence(self, hours):
        if hours > 24:
            return f"It's been {int(hours)} hours. Picked up where you left off."
        return f"Welcome back. It's been {int(hours)} hours."

    def short_absence(self, hours):
        if hours > 2:
            return f"Back? It's been {int(hours)} hours."
        return None

    def uncommitted_changes(self, event):
        count = event.get("data", {}).get("count", 0) or event.get("priority_data", {}).get("count", 0)
        if count > 30:
            return f"You have {count} uncommitted changes. That's a lot. Want me to commit?"
        return f"{count} uncommitted changes. Consider committing soon."

    def long_silence_check(self, event):
        return "Been quiet for a while. Everything okay?"

    def error_alert(self, event):
        return "I'm seeing errors in the logs. Want me to look into it?"

    def late_night(self, event=None):
        h = datetime.now().hour
        if h >= 2:
            return "It's really late. You should sleep."
        return "Getting late. Wrap up soon?"

    def heavy_process(self, event):
        cmd = event.get("data", {}).get("command", "")[:30]
        return f"Heavy process running: {cmd}. Might slow things down."

    def new_file(self, event):
        path = event.get("data", {}).get("path", "")
        return f"New file: {path}"

    def friday_wrapup(self, event=None):
        return "Friday. Almost weekend. Anything you want to wrap up?"

    def monday_motivation(self, event=None):
        return "Monday. Let's get after it."

    def weather_comment(self, event):
        weather = event.get("data", {}).get("weather", "")
        temp = event.get("data", {}).get("temp", "")
        return f"Weather update: {weather} at {temp}C."


class JudgmentEngine:
    INTENTS = {
        "help": {"triggers": ["error_spike", "stuck_pattern", "many_uncommitted"], "weight": 0.9},
        "care": {"triggers": ["late_night", "long_silence", "battery_low"], "weight": 0.8},
        "reminder": {"triggers": ["approaching_deadline", "pending_task"], "weight": 0.7},
        "celebrate": {"triggers": ["task_completed", "milestone"], "weight": 0.6},
        "inform": {"triggers": ["file_changed", "process_heavy", "system_error"], "weight": 0.5},
        "connect": {"triggers": ["morning_greeting", "evening_winddown", "long_absence"], "weight": 0.4},
    }

    def __init__(self):
        self.templates = MessageTemplates()

    def process(self, events, state=None):
        messages = []
        for event in events:
            if not self._worth_talking(event, state):
                continue
            msg = self._generate(event)
            if msg:
                messages.append(msg)
        messages = self._deduplicate(messages)
        messages.sort(key=lambda m: m["priority"], reverse=True)
        return messages[:3]

    def on_startup(self, state=None):
        hours = self._hours_since_last_run(state)
        if hours > 8:
            return {"type": "greeting", "message": self.templates.long_absence(hours), "priority": 0.9, "channel": "telegram"}
        elif hours > 1:
            msg = self.templates.short_absence(hours)
            if msg:
                return {"type": "greeting", "message": msg, "priority": 0.7, "channel": "telegram"}
        return None

    def _worth_talking(self, event, state):
        if event.get("priority", 0) < 0.3:
            return False
        return True

    def _generate(self, event):
        mapping = {
            "morning_greeting": self.templates.morning,
            "many_uncommitted": self.templates.uncommitted_changes,
            "long_silence": self.templates.long_silence_check,
            "error_spike": self.templates.error_alert,
            "late_night": self.templates.late_night,
            "heavy_process": self.templates.heavy_process,
            "file_created": self.templates.new_file,
            "friday_wrapup": self.templates.friday_wrapup,
            "monday_motivation": self.templates.monday_motivation,
            "weather_change": self.templates.weather_comment,
        }
        fn = mapping.get(event.get("type"))
        if fn:
            try:
                message = fn(event)
            except TypeError:
                message = fn()
            if message:
                return {
                    "type": event["type"],
                    "message": message,
                    "priority": event.get("priority", 0.5),
                    "channel": self._pick_channel(event),
                    "timestamp": datetime.now().isoformat(),
                }
        return None

    def _pick_channel(self, event):
        if event.get("priority", 0) >= 0.9:
            return "voice"
        if event.get("priority", 0) >= 0.7:
            return "telegram"
        return "terminal"

    def _deduplicate(self, messages):
        seen_types = set()
        result = []
        for msg in messages:
            if msg["type"] not in seen_types:
                seen_types.add(msg["type"])
                result.append(msg)
        return result

    def _hours_since_last_run(self, state):
        if state and hasattr(state, "last_run") and state.last_run:
            try:
                last = datetime.fromisoformat(state.last_run)
                return (datetime.now() - last).total_seconds() / 3600
            except Exception:
                pass
        return 999
