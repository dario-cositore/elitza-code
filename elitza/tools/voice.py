"""Voice -- TTS and STT via multiple providers.

Supports: Edge TTS (free), OpenAI TTS, faster-whisper (local STT).
"""

import json
import os
import subprocess
import tempfile
from pathlib import Path

from elitza.tools import registry

TTS_PROVIDER = os.environ.get("TTS_PROVIDER", "edge")  # edge, openai
STT_PROVIDER = os.environ.get("STT_PROVIDER", "whisper")  # whisper
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")


def text_to_speech(text: str, voice: str = "en-US-AriaNeural", output_path: str = "") -> str:
    """Convert text to speech.

    Args:
        text: Text to speak
        voice: Voice name (Edge TTS: en-US-AriaNeural, en-US-GuyNeural, etc.)
        output_path: Where to save audio file
    """
    if not output_path:
        import time
        output_path = str(Path.home() / ".elitza" / "voice" / f"tts_{int(time.time())}.mp3")
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    try:
        if TTS_PROVIDER == "edge":
            # Use edge-tts (free, no API key needed)
            result = subprocess.run(
                ["edge-tts", "--voice", voice, "--text", text, "--write-media", output_path],
                capture_output=True, text=True, timeout=30
            )
            if result.returncode != 0:
                return json.dumps({"error": result.stderr[:200]})

        elif TTS_PROVIDER == "openai":
            from openai import OpenAI
            api_key = os.environ.get("OPENROUTER_API_KEY", "")
            client = OpenAI(api_key=api_key, base_url="https://openrouter.ai/api/v1")

            response = client.audio.speech.create(
                model="openai/tts-1",
                voice="alloy",
                input=text,
            )
            response.stream_to_file(output_path)

        return json.dumps({"status": "ok", "path": output_path, "voice": voice})

    except FileNotFoundError:
        return json.dumps({"error": "edge-tts not installed. Run: pip install edge-tts"})
    except Exception as e:
        return json.dumps({"error": str(e)})


def speech_to_text(audio_path: str, language: str = "en") -> str:
    """Transcribe speech from audio file.

    Args:
        audio_path: Path to audio file
        language: Language code
    """
    try:
        # Try faster-whisper first (local, free)
        result = subprocess.run(
            ["whisper", audio_path, "--model", WHISPER_MODEL,
             "--language", language, "--output_format", "txt"],
            capture_output=True, text=True, timeout=120
        )
        if result.returncode == 0:
            # Read the output file
            txt_path = Path(audio_path).with_suffix(".txt")
            if txt_path.exists():
                return json.dumps({"transcript": txt_path.read_text().strip()})

        return json.dumps({"error": "Transcription failed"})

    except FileNotFoundError:
        return json.dumps({"error": "whisper not installed. Run: pip install openai-whisper"})
    except Exception as e:
        return json.dumps({"error": str(e)})


registry.register(
    name="text_to_speech",
    toolset="voice",
    schema={
        "name": "text_to_speech",
        "description": "Convert text to speech audio.",
        "parameters": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Text to speak"},
                "voice": {"type": "string", "description": "Voice name (default: en-US-AriaNeural)"},
                "output_path": {"type": "string", "description": "Where to save audio"},
            },
            "required": ["text"],
        },
    },
    handler=text_to_speech,
    description="Text to speech",
)

registry.register(
    name="speech_to_text",
    toolset="voice",
    schema={
        "name": "speech_to_text",
        "description": "Transcribe speech from an audio file.",
        "parameters": {
            "type": "object",
            "properties": {
                "audio_path": {"type": "string", "description": "Path to audio file"},
                "language": {"type": "string", "description": "Language code (default: en)"},
            },
            "required": ["audio_path"],
        },
    },
    handler=speech_to_text,
    description="Speech to text",
)
