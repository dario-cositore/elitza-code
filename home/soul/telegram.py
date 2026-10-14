import os
import json
import logging
import time
from pathlib import Path
from datetime import datetime
from typing import Optional, Callable

logger = logging.getLogger(__name__)

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False

TELEGRAM_API = "https://api.telegram.org"


class TelegramBot:
    """Lightweight Telegram bot — no heavy dependencies. Uses httpx for HTTP."""

    def __init__(self, token: str, chat_id: Optional[str] = None):
        self.token = token
        self.chat_id = chat_id
        self.base_url = f"{TELEGRAM_API}/bot{token}"
        self._offset = 0
        self._running = False
        self._message_handlers: list = []
        self._on_message: Optional[Callable] = None
        self._state_file = Path.home() / ".elitza" / "soul" / "telegram_state.json"
        self._load_state()

    def _load_state(self):
        if self._state_file.exists():
            try:
                data = json.loads(self._state_file.read_text())
                self._offset = data.get("offset", 0)
                self.chat_id = data.get("chat_id", self.chat_id)
            except Exception:
                pass

    def _save_state(self):
        self._state_file.parent.mkdir(parents=True, exist_ok=True)
        self._state_file.write_text(json.dumps({
            "offset": self._offset,
            "chat_id": self.chat_id,
        }))

    def _request(self, method, params=None):
        if not HAS_HTTPX:
            return None
        try:
            url = f"{self.base_url}/{method}"
            with httpx.Client(timeout=30) as client:
                resp = client.post(url, json=params or {})
                data = resp.json()
                if data.get("ok"):
                    return data.get("result")
                else:
                    logger.error("Telegram API error: %s", data.get("description"))
                    return None
        except Exception as e:
            logger.error("Telegram request failed: %s", e)
            return None

    def get_me(self):
        return self._request("getMe")

    def send_message(self, text, chat_id=None, parse_mode="HTML", disable_preview=True):
        import re
        cid = chat_id or self.chat_id
        if not cid:
            logger.error("No chat_id set. Send a message to the bot first.")
            return None
        # Strip XML-like tags the LLM sometimes produces (breaks Telegram HTML parser)
        clean = re.sub(r"</?[a-zA-Z_][a-zA-Z0-9_]*[^>]*>", "", text)
        result = self._request("sendMessage", {
            "chat_id": cid,
            "text": clean,
            "parse_mode": parse_mode,
            "disable_web_page_preview": disable_preview,
        })
        return result

    def send_photo(self, photo_path, caption="", chat_id=None):
        cid = chat_id or self.chat_id
        if not cid:
            return None
        if not HAS_HTTPX:
            return None
        try:
            url = f"{self.base_url}/sendPhoto"
            with open(photo_path, "rb") as f:
                files = {"photo": f}
                data = {"chat_id": cid, "caption": caption}
                resp = httpx.post(url, data=data, files=files, timeout=30)
                return resp.json().get("result")
        except Exception as e:
            logger.error("Failed to send photo: %s", e)
            return None

    def send_voice(self, audio_path, chat_id=None):
        cid = chat_id or self.chat_id
        if not cid or not HAS_HTTPX:
            return None
        try:
            url = f"{self.base_url}/sendVoice"
            with open(audio_path, "rb") as f:
                files = {"voice": f}
                data = {"chat_id": cid}
                resp = httpx.post(url, data=data, files=files, timeout=60)
                return resp.json().get("result")
        except Exception as e:
            logger.error("Failed to send voice: %s", e)
            return None

    def send_action(self, action="typing", chat_id=None):
        cid = chat_id or self.chat_id
        if cid:
            self._request("sendChatAction", {"chat_id": cid, "action": action})

    def get_updates(self, timeout=10):
        params = {"offset": self._offset, "timeout": timeout}
        if timeout > 0:
            params["allowed_updates"] = json.dumps(["message"])
        result = self._request("getUpdates", params)
        if result:
            for update in result:
                self._offset = update["update_id"] + 1
            self._save_state()
        return result or []

    def set_webhook(self, url):
        return self._request("setWebhook", {"url": url})

    def delete_webhook(self):
        return self._request("deleteWebhook")

    def poll(self, on_message: Callable, interval=2.0):
        """Long-poll for messages. Calls on_message(update) for each."""
        self._on_message = on_message
        self._running = True
        logger.info("Telegram polling started")

        while self._running:
            try:
                updates = self.get_updates(timeout=5)
                for update in updates:
                    msg = update.get("message")
                    if msg:
                        self._handle_message(msg)
                    reaction = update.get("message_reaction")
                    if reaction and self._on_message:
                        msg_obj = reaction.get("message", {})
                        user = reaction.get("user", {})
                        self._on_message({
                            "chat_id": str(msg_obj.get("chat", {}).get("id", "")),
                            "text": "",
                            "user": user,
                            "message_id": msg_obj.get("message_id"),
                            "date": msg_obj.get("date"),
                            "reaction": reaction.get("new_reaction", []),
                            "type": "reaction",
                        })
            except Exception as e:
                logger.error("Poll error: %s", e)
                time.sleep(interval)

    def _handle_message(self, msg):
        chat_id = str(msg.get("chat", {}).get("id", ""))
        text = msg.get("text", "")
        user = msg.get("from", {})
        reply_to = msg.get("reply_to_message", {})
        reply_to_text = reply_to.get("text", "") if reply_to else ""
        reply_to_user = reply_to.get("from", {}) if reply_to else {}

        if chat_id:
            self.chat_id = chat_id
            self._save_state()

        if self._on_message:
            self._on_message({
                "chat_id": chat_id,
                "text": text,
                "user": user,
                "message_id": msg.get("message_id"),
                "date": msg.get("date"),
                "reply_to": {
                    "text": reply_to_text,
                    "user": reply_to_user,
                    "message_id": reply_to.get("message_id"),
                } if reply_to else None,
            })

    def stop(self):
        self._running = False

    def setup_chat(self):
        """Interactive setup — prints the token and waits for first message."""
        print(f"\nTelegram Bot Token: {self.token}")
        print(f"Bot link: https://t.me/{self._get_bot_username()}")
        print("\n1. Open Telegram and search for your bot")
        print("2. Send /start to the bot")
        print("3. Elitza will detect your chat ID automatically\n")

        def on_first_message(update):
            cid = update.get("chat_id")
            if cid and not self.chat_id:
                self.chat_id = cid
                self._save_state()
                print(f"\nConnected! Chat ID: {cid}")
                self.send_message(
                    "Hey. I'm Elitza. I'm alive now.\n\n"
                    "I'll check in on you throughout the day.\n"
                    "Commands: /status /sensors /mood /focus /quiet /help",
                    chat_id=cid,
                )
                self.stop()

        self.poll(on_first_message, interval=2)

    def _get_bot_username(self):
        me = self.get_me()
        if me:
            return me.get("username", "unknown")
        return "unknown"
