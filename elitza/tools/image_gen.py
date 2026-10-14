"""Image Generation -- create images via OpenAI gpt-image-2.

Generates images from text prompts.
"""

import base64
import json
import os
import urllib.request
from pathlib import Path

from elitza.tools import registry

OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "")
IMAGES_DIR = Path.home() / ".elitza" / "images"


def image_generate(prompt: str, size: str = "1024x1024", save_path: str = "") -> str:
    """Generate an image from a text prompt.

    Args:
        prompt: Description of the image to generate
        size: Image size (1024x1024, 1024x1792, 1792x1024)
        save_path: Where to save the image (auto-generated if empty)
    """
    if not OPENROUTER_KEY:
        return json.dumps({"error": "OPENROUTER_API_KEY not set"})

    try:
        from openai import OpenAI

        client = OpenAI(
            api_key=OPENROUTER_KEY,
            base_url="https://openrouter.ai/api/v1",
        )

        response = client.images.generate(
            model="openai/gpt-image-2",
            prompt=prompt,
            n=1,
            size=size,
        )

        # Get the image data
        image_data = response.data[0]

        # Save to file
        IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        if not save_path:
            import time
            save_path = str(IMAGES_DIR / f"img_{int(time.time())}.png")

        if hasattr(image_data, 'b64_json') and image_data.b64_json:
            img_bytes = base64.b64decode(image_data.b64_json)
            Path(save_path).write_bytes(img_bytes)
        elif hasattr(image_data, 'url') and image_data.url:
            urllib.request.urlretrieve(image_data.url, save_path)

        return json.dumps({
            "status": "generated",
            "path": save_path,
            "prompt": prompt,
            "size": size,
        })

    except Exception as e:
        return json.dumps({"error": str(e)})


registry.register(
    name="image_generate",
    toolset="vision",
    schema={
        "name": "image_generate",
        "description": "Generate an image from a text prompt using AI.",
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "Description of the image to generate"},
                "size": {"type": "string", "description": "Image size (1024x1024, 1024x1792, 1792x1024)"},
                "save_path": {"type": "string", "description": "Where to save the image"},
            },
            "required": ["prompt"],
        },
    },
    handler=image_generate,
    description="Generate images",
)
