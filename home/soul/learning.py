import json
from pathlib import Path
from datetime import datetime


class ProactiveLearning:
    def __init__(self):
        self.data_dir = Path.home() / ".elitza" / "soul" / "learning"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.effectiveness = self._load("effectiveness.json", {
            "greeting": 0.5,
            "reminder": 0.5,
            "alert": 0.5,
            "suggestion": 0.5,
            "observation": 0.5,
        })
        self.response_log = self._load("responses.json", [])

    def _load(self, name, default):
        path = self.data_dir / name
        if path.exists():
            try:
                return json.loads(path.read_text())
            except Exception:
                pass
        return default

    def _save(self, name, data):
        path = self.data_dir / name
        path.write_text(json.dumps(data, indent=2, default=str))

    def record_response(self, message, user_response):
        engagement = self._measure_engagement(user_response)
        msg_type = message.get("type", "unknown")

        current = self.effectiveness.get(msg_type, 0.5)
        if engagement == "positive":
            new_score = min(1.0, current + 0.1)
        elif engagement == "negative":
            new_score = max(0.0, current - 0.2)
        else:
            new_score = current
        self.effectiveness[msg_type] = new_score
        self._save("effectiveness.json", self.effectiveness)

        self.response_log.append({
            "message_type": msg_type,
            "message_text": message.get("message", ""),
            "user_response": user_response,
            "engagement": engagement,
            "timestamp": datetime.now().isoformat(),
        })
        self.response_log = self.response_log[-200:]
        self._save("responses.json", self.response_log)

    def _measure_engagement(self, response):
        r = response.lower().strip()
        if any(w in r for w in ["thanks", "good", "nice", "ok", "yes", "sure", "cool"]):
            return "positive"
        if any(w in r for w in ["stop", "quiet", "no", "shut", "annoying", "go away", "stfu"]):
            return "negative"
        if any(w in r for w in ["k", "got it", "noted", "mhm"]):
            return "neutral"
        if not r:
            return "ignored"
        return "neutral"

    def get_speaking_preferences(self):
        prefs = {}
        for msg_type, score in self.effectiveness.items():
            if score > 0.8:
                freq = "often"
            elif score > 0.5:
                freq = "sometimes"
            elif score > 0.3:
                freq = "rarely"
            else:
                freq = "never"
            prefs[msg_type] = {
                "effectiveness": score,
                "should_speak": score > 0.3,
                "frequency": freq,
            }
        return prefs

    def get_disabled_types(self):
        return [t for t, s in self.effectiveness.items() if s <= 0.1]
