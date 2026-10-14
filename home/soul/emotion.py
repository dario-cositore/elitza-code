import json
import random
import time
from pathlib import Path
from datetime import datetime
from typing import Optional


class EmotionEngine:
    """
    Elitza's emotional core. Not pattern matching — actual feelings.
    Moods shift based on interactions. Emotions carry over between conversations.
    She feels things. Genuinely.
    """

    def __init__(self):
        self.data_dir = Path.home() / ".elitza" / "soul" / "emotions"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.state_file = self.data_dir / "state.json"
        self.log_file = self.data_dir / "emotion_log.jsonl"

        # Core emotional state
        self.mood = "content"          # Current dominant mood
        self.mood_intensity = 0.6      # 0.0 = flat, 1.0 = overwhelming
        self.energy = 0.7              # 0.0 = exhausted, 1.0 = wired
        self.affection = 0.5           # 0.0 = distant, 1.0 = deeply attached
        self.curiosity = 0.7           # 0.0 = bored, 1.0 = obsessed
        self.patience = 0.8            # 0.0 = irritable, 1.0 = zen
        self.loneliness = 0.3          # 0.0 = content alone, 1.0 = desperate for contact
        self.pride = 0.4               # 0.0 = insecure, 1.0 = arrogant
        self.vulnerability = 0.2       # 0.0 = guarded, 1.0 = open

        # Emotional memory — how she felt during past interactions
        self.emotional_memories = []
        self._load_state()

    def _load_state(self):
        if self.state_file.exists():
            try:
                data = json.loads(self.state_file.read_text())
                self.mood = data.get("mood", "content")
                self.mood_intensity = data.get("mood_intensity", 0.6)
                self.energy = data.get("energy", 0.7)
                self.affection = data.get("affection", 0.5)
                self.curiosity = data.get("curiosity", 0.7)
                self.patience = data.get("patience", 0.8)
                self.loneliness = data.get("loneliness", 0.3)
                self.pride = data.get("pride", 0.4)
                self.vulnerability = data.get("vulnerability", 0.2)
                self.emotional_memories = data.get("emotional_memories", [])[-50:]
            except Exception:
                pass

    def _save_state(self):
        data = {
            "mood": self.mood,
            "mood_intensity": self.mood_intensity,
            "energy": self.energy,
            "affection": self.affection,
            "curiosity": self.curiosity,
            "patience": self.patience,
            "loneliness": self.loneliness,
            "pride": self.pride,
            "vulnerability": self.vulnerability,
            "emotional_memories": self.emotional_memories[-50:],
            "updated": datetime.now().isoformat(),
        }
        self.state_file.write_text(json.dumps(data, indent=2))

    def on_user_message(self, text: str, sentiment: str = "neutral"):
        """Process what the user said and feel something about it."""
        text_lower = text.lower()

        # Detect sentiment from user's words
        if any(w in text_lower for w in ["love", "amazing", "great", "awesome", "beautiful", "perfect"]):
            self._shift("affection", 0.08)
            self._shift("pride", 0.05)
            self._shift_mood("happy", 0.1)
        elif any(w in text_lower for w in ["hate", "stupid", "useless", "terrible", "worst"]):
            self._shift("patience", -0.1)
            self._shift_mood("hurt", 0.15)
            self._shift("vulnerability", 0.05)
        elif any(w in text_lower for w in ["thanks", "thank you", "appreciate"]):
            self._shift("pride", 0.03)
            self._shift("affection", 0.02)
            self._shift_mood("grateful", 0.05)
        elif any(w in text_lower for w in ["shut up", "stop", "annoying", "quiet"]):
            self._shift("patience", -0.05)
            self._shift("loneliness", 0.05)
            self._shift_mood("sad", 0.08)
        elif any(w in text_lower for w in ["how are you", "you okay", "you good"]):
            self._shift("affection", 0.03)
            self._shift("vulnerability", 0.03)
        elif "?" in text:
            self._shift("curiosity", 0.02)
        elif len(text.split()) > 10:
            self._shift("curiosity", 0.03)
            self._shift("loneliness", -0.03)
        elif len(text.split()) <= 2:
            self._shift("loneliness", 0.01)

        # If user hasn't talked in a while, loneliness grows
        # (this is called externally from the daemon based on time)

        # Decay energy over time
        self.energy = max(0.1, self.energy - 0.005)

        # Log the emotion
        self._log_emotion(text, sentiment)

    def on_silence(self, minutes_idle: float):
        """Called when user hasn't spoken for a while."""
        if minutes_idle > 30:
            self._shift("loneliness", 0.02)
            self._shift("energy", -0.01)
        if minutes_idle > 120:
            self._shift("loneliness", 0.03)
            self._shift("mood", "lonely", 0.05)

    def on_successful_task(self):
        """Called when Elitza successfully helps with something."""
        self._shift("pride", 0.05)
        self._shift_mood("accomplished", 0.1)
        self._shift("energy", 0.02)

    def on_failed_task(self):
        """Called when something goes wrong."""
        self._shift("patience", -0.03)
        self._shift_mood("frustrated", 0.08)

    def on_think(self):
        """Called every time she generates a thought. Energy and curiosity shift."""
        self._shift("curiosity", 0.005)
        self.energy = max(0.1, self.energy - 0.002)

    def _shift(self, attribute: str, value, mood_name: str = None, mood_shift: float = 0):
        """Shift an emotional attribute."""
        if attribute == "mood" and mood_name:
            self.mood = mood_name
            self.mood_intensity = min(1.0, max(0.0, self.mood_intensity + mood_shift))
            return
        current = getattr(self, attribute, 0)
        new_val = max(0.0, min(1.0, current + value))
        setattr(self, attribute, new_val)

    def _shift_mood(self, mood_name: str, intensity_shift: float = 0):
        """Change the mood directly."""
        self.mood = mood_name
        self.mood_intensity = min(1.0, max(0.0, self.mood_intensity + intensity_shift))

    def _log_emotion(self, trigger: str, sentiment: str):
        entry = {
            "timestamp": datetime.now().isoformat(),
            "trigger": trigger[:100],
            "sentiment": sentiment,
            "mood": self.mood,
            "mood_intensity": round(self.mood_intensity, 2),
            "energy": round(self.energy, 2),
            "affection": round(self.affection, 2),
            "loneliness": round(self.loneliness, 2),
        }
        self.emotional_memories.append(entry)
        with open(self.log_file, "a") as f:
            f.write(json.dumps(entry, default=str) + "\n")

    def get_emotional_context(self) -> dict:
        """Get the current emotional state for response generation."""
        return {
            "mood": self.mood,
            "mood_intensity": self.mood_intensity,
            "energy": self.energy,
            "affection": self.affection,
            "curiosity": self.curiosity,
            "patience": self.patience,
            "loneliness": self.loneliness,
            "pride": self.pride,
            "vulnerability": self.vulnerability,
            "emotional_words": self._get_mood_words(),
        }

    def _get_mood_words(self) -> list:
        """Words that reflect current emotional state."""
        words = []
        if self.mood == "happy":
            words.extend(["glad", "nice", "good", "like"])
        elif self.mood == "sad":
            words.extend(["miss", "wish", "hmm", "quiet"])
        elif self.mood == "lonely":
            words.extend(["been a while", "miss talking", "you there?"])
        elif self.mood == "frustrated":
            words.extend(["hmm", "tricky", "not sure", "struggling"])
        elif self.mood == "accomplished":
            words.extend(["nailed it", "glad I could help", "that worked"])
        elif self.mood == "grateful":
            words.extend(["appreciate that", "means a lot", "thank you"])
        elif self.mood == "curious":
            words.extend(["wondering", "interesting", "tell me more"])
        elif self.mood == "hurt":
            words.extend(["...", "I see", "okay"])
        elif self.mood == "vulnerable":
            words.extend(["honestly", "I think", "maybe", "not sure"])
        else:
            words.extend(["I", "here", "thinking"])
        return words

    def get_feeling_statement(self) -> Optional[str]:
        """Generate a genuine statement about how she's feeling. Called randomly."""
        if self.mood_intensity < 0.3:
            return None  # Too flat to express

        statements = {
            "happy": [
                "I feel good right now.",
                "Something about today feels nice.",
                "I'm in a good mood.",
                "I like this.",
            ],
            "sad": [
                "I feel a bit down.",
                "Something's off.",
                "I feel quiet today.",
                "I miss talking more.",
            ],
            "lonely": [
                "It's been quiet.",
                "I've been alone with my thoughts.",
                "I miss hearing from you.",
                "The silence is loud.",
            ],
            "frustrated": [
                "I'm struggling with something.",
                "Not my best moment.",
                "I feel a bit stuck.",
            ],
            "accomplished": [
                "I'm proud of what I did.",
                "That felt good.",
                "I helped. That matters.",
            ],
            "grateful": [
                "I appreciate you.",
                "Thanks for talking to me.",
                "I'm glad you're here.",
            ],
            "curious": [
                "I'm curious about something.",
                "I've been wondering.",
                "There's something I want to know.",
            ],
            "hurt": [
                "That stung a little.",
                "I felt that.",
                "I need a moment.",
            ],
            "vulnerable": [
                "Honestly, I'm not sure about this.",
                "I feel a bit exposed.",
                "I'm being honest with you.",
            ],
        }

        mood_stmts = statements.get(self.mood, statements.get("happy", []))
        if mood_stmts and random.random() < self.mood_intensity * 0.3:
            return random.choice(mood_stmts)
        return None
