"""Context Compressor -- smart conversation summarization.

When context gets too large, summarizes old messages while preserving
the first few and most recent messages.
"""

import json
import logging
from typing import List, Dict, Optional

logger = logging.getLogger(__name__)

# Defaults
COMPRESS_THRESHOLD = 0.85  # trigger at 85% context usage
COMPRESS_TARGET = 0.3     # compress to 30% of original
PROTECT_FIRST = 3          # always keep first N messages
PROTECT_LAST = 10          # always keep last N messages
MAX_MESSAGES = 200         # forced hygiene threshold


class ContextCompressor:
    """Smart conversation compressor that preserves important context."""

    def __init__(self, agent):
        self.agent = agent

    def should_compress(self) -> bool:
        """Check if compression is needed."""
        if not self.agent.messages:
            return False
        if len(self.agent.messages) > MAX_MESSAGES:
            return True
        estimated = self.agent._estimate_context_tokens()
        threshold = int(self.agent._context_window * COMPRESS_THRESHOLD)
        return estimated > threshold

    def compress(self) -> str:
        """Compress conversation by summarizing old messages."""
        if not self.agent.messages or len(self.agent.messages) <= PROTECT_FIRST + PROTECT_LAST:
            return "Too short to compress"

        # Save checkpoint before compressing
        self.agent.save_checkpoint()

        # Split messages
        protected_first = self.agent.messages[:PROTECT_FIRST]
        protected_last = self.agent.messages[-PROTECT_LAST:]
        to_compress = self.agent.messages[PROTECT_FIRST:-PROTECT_LAST]

        if not to_compress:
            return "Nothing to compress"

        # Build summary of compressed portion
        summary_parts = []
        summary_parts.append(f"[Conversation summary: {len(to_compress)} messages compressed]")

        # Extract key topics, decisions, and tool uses
        topics = set()
        tools_used = set()
        key_points = []

        for msg in to_compress:
            role = msg.get("role", "")
            content = str(msg.get("content", ""))

            # Extract tool calls
            if role == "assistant" and msg.get("tool_calls"):
                for tc in msg["tool_calls"]:
                    if isinstance(tc, dict):
                        name = tc.get("function", {}).get("name", "")
                        if name:
                            tools_used.add(name)

            # Extract key points from assistant messages
            if role == "assistant" and len(content) > 20:
                # First sentence as key point
                first_sentence = content.split(".")[0].strip()
                if len(first_sentence) > 10:
                    key_points.append(first_sentence[:150])

            # Track topics from user messages
            if role == "user":
                words = content.lower().split()[:20]
                topics.update(w for w in words if len(w) > 4)

        # Build compressed message
        compressed_content = "\n".join(summary_parts)
        if tools_used:
            compressed_content += f"\nTools used: {', '.join(sorted(tools_used))}"
        if key_points:
            compressed_content += "\nKey points:"
            for kp in key_points[:5]:
                compressed_content += f"\n  - {kp}"

        # Create compressed message
        compressed_msg = {
            "role": "user",
            "content": compressed_content,
            "_compressed": True,  # Marker for future compression
            "_original_count": len(to_compress),
        }

        # Reconstruct messages
        self.agent.messages = protected_first + [compressed_msg] + protected_last

        return f"Compressed {len(to_compress)} messages into summary"

    def forced_hygiene(self) -> str:
        """Force compression when message count exceeds limit."""
        if len(self.agent.messages) <= MAX_MESSAGES:
            return "No hygiene needed"

        # Keep first 2 and last 15
        keep_first = self.agent.messages[:2]
        keep_last = self.agent.messages[-15:]
        drop_count = len(self.agent.messages) - 2 - 15

        self.agent.messages = keep_first + keep_last
        return f"Hygiene: dropped {drop_count} middle messages"

    def get_compressed_tokens(self) -> int:
        """Estimate tokens after compression."""
        if not self.agent.messages:
            return 0
        total_chars = sum(len(str(m.get("content", ""))) for m in self.agent.messages)
        return total_chars // 4
