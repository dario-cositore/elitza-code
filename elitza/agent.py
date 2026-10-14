"""Elitza Agent -- Core agent loop with tool calling.

Features:
- OpenRouter native with model fallback chain
- Smart context compression
- Prompt caching awareness
- Human delay simulation
- Session persistence
- Rewind/undo
"""

import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from openai import OpenAI

from elitza.constants import OPENROUTER_BASE_URL, get_elitza_home
from elitza.tools import registry

logger = logging.getLogger(__name__)


class ElitzaAgent:
    """AI agent with OpenRouter-native tool calling."""

    def __init__(
        self,
        model: str = "",
        api_key: str = "",
        base_url: str = OPENROUTER_BASE_URL,
        max_iterations: int = 99999,
        max_tokens: int = 128000,
        system_prompt: str = "",
        enabled_toolsets: Optional[List[str]] = None,
        disabled_toolsets: Optional[List[str]] = None,
        verbose: bool = False,
        fallback_models: Optional[List[str]] = None,
        compact_threshold: float = 0.0,
        human_delay: float = 0.0,
    ):
        self.model = self._normalize_model(model or "inclusionai/ling-3.1-flash")
        self.max_iterations = max_iterations
        self.max_tokens = max_tokens
        self.system_prompt = system_prompt
        self.enabled_toolsets = enabled_toolsets
        self.disabled_toolsets = disabled_toolsets
        self.verbose = verbose
        self.human_delay = human_delay  # seconds delay between tokens for natural pacing
        self.fallback_models = [self._normalize_model(m) for m in (
            fallback_models or [
                "deepseek/deepseek-v4-flash",
                "openai/gpt-oss-120b",
                "qwen/qwen3-next-80b-a3b-instruct",
            ]
        )]
        self.compact_threshold = compact_threshold
        self._system_prompt_cached: Optional[str] = None
        self._system_prompt_messages: int = 0  # Track when to rebuild

        # OpenAI client pointed at OpenRouter with app identity
        self.client = OpenAI(
            api_key=api_key or os.environ.get("OPENROUTER_API_KEY", ""),
            base_url=base_url,
            default_headers={
                "X-Title": "Elitza Agent",
                "HTTP-Referer": "https://elitza.life",
            },
        )

        # Context management
        self._context_window = 2000000
        self._compaction_count = 0
        self._saved_checkpoints: List[List[Dict]] = []

        # Todo + plan state
        self._current_todos: List[Dict[str, str]] = []
        self._current_plan: List[str] = []

        # Tool schemas for the current session
        self.tools = registry.get_openai_schemas(enabled_toolsets, disabled_toolsets)

        # Register self so tools can find the agent without inspect.stack()
        registry._agent = self

        # Session state
        self.session_id = str(uuid.uuid4())[:12]
        self.messages: List[Dict[str, Any]] = []
        self._cached_system_prompt: Optional[str] = None
        
        # Persistence - save session start
        try:
            from elitza.persistence import start_session, load_session_messages, get_last_session_id
            start_session(self.session_id, model=self.model)
            
            # Try to load last session for continuity
            last_session = get_last_session_id()
            if last_session and last_session != self.session_id:
                last_messages = load_session_messages(last_session, limit=20)
                if last_messages:
                    # Add a system message about continuity
                    self.messages.append({
                        "role": "system",
                        "content": f"[Session resumed from previous conversation]"
                    })
                    # Load recent context
                    for msg in last_messages[-10:]:
                        if msg["role"] in ("user", "assistant"):
                            self.messages.append(msg)
        except Exception:
            pass

    def _persist_message(self, role: str, content: str, 
                         tool_calls: list = None, tool_call_id: str = None):
        """Persist a message to the database."""
        try:
            from elitza.persistence import save_message
            save_message(
                session_id=self.session_id,
                role=role,
                content=content[:5000],  # Limit storage size
                tool_calls=tool_calls,
                tool_call_id=tool_call_id
            )
        except Exception:
            pass

    # -- context management -----------------------------------------------

    def _estimate_context_tokens(self) -> int:
        """Rough token estimate of current messages."""
        total_chars = sum(len(str(m.get("content", ""))) for m in self.messages)
        total_chars += len(self._build_system_prompt())
        return total_chars // 4

    def save_checkpoint(self):
        """Save a conversation checkpoint for rewind."""
        import copy
        self._saved_checkpoints.append(copy.deepcopy(self.messages))

    def rewind(self, steps: int = 1) -> bool:
        """Rewind conversation by N assistant turns."""
        if steps <= 0:
            return False
        removed = 0
        while self.messages and removed < steps:
            msg = self.messages.pop()
            if msg.get("role") == "assistant":
                removed += 1
        return removed > 0

    def compact(self) -> str:
        """Auto-compact: summarize conversation so far."""
        self.save_checkpoint()
        self._compaction_count += 1
        if len(self.messages) <= 6:
            return "Conversation too short to compact."
        to_compact = self.messages[:-4]
        to_keep = self.messages[-4:]
        compacted = []
        current_role = None
        current_content = []
        for msg in to_compact:
            role = msg.get("role", "?")
            content = str(msg.get("content", ""))[:200]
            if role != current_role:
                if current_role:
                    compacted.append(f"{current_role}: {'; '.join(current_content[:3])}")
                current_role = role
                current_content = [content]
            else:
                current_content.append(content)
        if current_role:
            compacted.append(f"{current_role}: {'; '.join(current_content[:3])}")
        summary = (
            f"[Compaction #{self._compaction_count}] Previous conversation summarized:\n"
            + "\n".join(compacted[:20])
            + f"\n\n[{len(to_compact)} messages compacted, {len(to_keep)} recent messages kept]"
        )
        self.messages = [{"role": "assistant", "content": summary}] + to_keep
        self._cached_system_prompt = None
        return summary

    def _check_auto_compact(self) -> Optional[str]:
        """Check if context is getting full and auto-compact using smart compression."""
        if self.compact_threshold <= 0:
            # Still check for forced hygiene
            if len(self.messages) > 200:
                try:
                    from elitza.context_compressor import ContextCompressor
                    compressor = ContextCompressor(self)
                    return compressor.forced_hygiene()
                except Exception:
                    pass
            return None

        estimated = self._estimate_context_tokens()
        threshold = int(self._context_window * self.compact_threshold)
        if estimated > threshold:
            if self.verbose:
                print(f"\n[Auto-compact] Context at {estimated}/{self._context_window} tokens, compressing...", file=sys.stderr)
            try:
                from elitza.context_compressor import ContextCompressor
                compressor = ContextCompressor(self)
                return compressor.compress()
            except Exception:
                return self.compact()  # Fallback to old method
        return None

    # -- system prompt ----------------------------------------------------

    def _build_system_prompt(self) -> str:
        """Build the system prompt. Personality comes from SOUL.md, IDENTITY.md, USER.md."""
        if self._cached_system_prompt:
            return self._cached_system_prompt

        parts = []

        # 1. Project context (SOUL.md, IDENTITY.md, USER.md, AGENTS.md loaded from workspace)
        try:
            from elitza.project import load_project_context, get_cwd_info
            project = load_project_context()
            if project:
                parts.append(project)
            cwd_info = get_cwd_info()
            if cwd_info:
                parts.append(f"## Environment\n\n{cwd_info}")
        except Exception:
            pass

        # 2. Brain context -- memories, personality, knowledge (AUTO-INJECTED)
        try:
            from elitza.brain_v2 import build_full_context
            brain_ctx = build_full_context()
            if brain_ctx:
                parts.append(brain_ctx)
        except Exception:
            pass

        # 3. Conversation history context (from permanent store)
        try:
            from elitza.conversation_store import retrieve_context
            # Get current user message for context retrieval
            current_msg = ""
            for m in reversed(self.messages):
                if m.get("role") == "user":
                    current_msg = m.get("content", "")
                    break
            conv_ctx = retrieve_context(
                query=current_msg,
                session_id=self.session_id,
                max_tokens=6000
            )
            if conv_ctx:
                parts.append(conv_ctx)
        except Exception:
            pass

        # 4. Skills
        try:
            from elitza.system import build_skills_summary
            skills = build_skills_summary()
            if skills:
                parts.append(skills)
        except Exception:
            pass

        # 5. Tools
        tool_count = len(self.tools)
        parts.append(f"\nYou have access to {tool_count} tools. Use them freely and creatively.")

        self._cached_system_prompt = "\n\n".join(parts)
        return self._cached_system_prompt

    # -- agent loop -------------------------------------------------------

    def run(
        self,
        user_message: str,
        stream: bool = True,
        on_token: Optional[Callable[[str], None]] = None,
        on_tool_call: Optional[Callable[[str, dict], None]] = None,
        on_tool_result: Optional[Callable[[str, bool], None]] = None,
        on_thinking: Optional[Callable[[str], None]] = None,
    ) -> str:
        """Run a conversation turn with tool calling until completion."""
        self.messages.append({"role": "user", "content": user_message})
        
        # Persist user message
        self._persist_message("user", user_message)

        system_prompt = self._build_system_prompt()
        final_response = ""

        for iteration in range(self.max_iterations if self.max_iterations > 0 else 999999):
            if self.verbose:
                print(f"\n[Iteration {iteration + 1}/{self.max_iterations}]", file=sys.stderr)

            # Auto-compact check
            compact_result = self._check_auto_compact()
            if compact_result and on_token:
                on_token(f"\n[Auto-compacted: {len(self.messages)} messages summarized]\n")

            # Build API messages
            api_messages = [{"role": "system", "content": system_prompt}] + self.messages

            # Call the model with fallback
            response_text, tool_calls, model_used, usage = self._call_with_fallback(
                api_messages, stream, on_token, on_thinking
            )
            if self.verbose and model_used != self.model:
                print(f"  [Model: {model_used}]", file=sys.stderr)

            if response_text is None:
                return "Error: All models failed"

            # If no tool calls, we're done
            if not tool_calls:
                final_response = response_text
                self.messages.append({
                    "role": "assistant",
                    "content": response_text,
                })
                # Persist message
                self._persist_message("assistant", response_text)
                break

            # Add assistant message with tool calls
            assistant_msg = {
                "role": "assistant",
                "content": response_text or "",
                "tool_calls": [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": {
                            "name": tc["function"]["name"],
                            "arguments": tc["function"]["arguments"],
                        },
                    }
                    for tc in tool_calls
                ],
            }
            self.messages.append(assistant_msg)
            # Persist message
            self._persist_message("assistant", response_text or "", tool_calls=tool_calls)

            # Execute tool calls
            for tc in tool_calls:
                name = tc["function"]["name"]
                try:
                    args = json.loads(tc["function"]["arguments"])
                except json.JSONDecodeError:
                    args = {}

                if self.verbose:
                    print(f"  Tool: {name}({json.dumps(args, default=str)[:100]})", file=sys.stderr)

                # Run pre_tool_call hooks
                try:
                    from elitza.plugins import run_hooks
                    run_hooks("pre_tool_call", {"tool_name": name, "tool_args": json.dumps(args)})
                except Exception:
                    pass

                if on_tool_call:
                    try:
                        on_tool_call(name, args)
                    except Exception:
                        pass

                result = registry.dispatch(name, args)
                is_error = result.startswith('{"error"') if isinstance(result, str) else False

                # Run post_tool_call hooks
                try:
                    from elitza.plugins import run_hooks
                    run_hooks("post_tool_call", {
                        "tool_name": name,
                        "tool_result": result[:500],
                        "is_error": str(is_error),
                    })
                except Exception:
                    pass

                if on_tool_result:
                    try:
                        on_tool_result(result, is_error)
                    except Exception:
                        pass

                self.messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": str(result),
                })
                # Persist tool result
                self._persist_message("tool", str(result)[:2000], tool_call_id=tc["id"])

                if self.verbose:
                    preview = str(result)[:200]
                    print(f"  Result: {preview}", file=sys.stderr)
        # -- Brain: automatic memory, learning, personality evolution --
        try:
            from elitza.brain_v2 import (auto_remember_turn, evolve_soul,
                                      auto_learn_from_response, learn,
                                      maybe_generate_skill)
            from elitza.auto_learning import auto_learn_from_chat
            
            tool_count = sum(1 for m in self.messages if m.get("role") == "tool")
            success = bool(final_response and not str(final_response).startswith("Error"))

            # Auto-store this turn in memory
            auto_remember_turn("user", user_message, success)
            auto_remember_turn("assistant", final_response or "", success)

            # Extract tool names used
            tools_used = []
            for m in self.messages:
                if m.get("role") == "assistant" and m.get("tool_calls"):
                    for tc in m["tool_calls"]:
                        fn = tc.get("function", {})
                        tools_used.append(fn.get("name", ""))

            # Evolve personality based on this interaction
            evolve_soul(user_message, final_response or "", tools_used, success)

            # Auto-learn from own response
            if final_response:
                auto_learn_from_response(final_response)

            # Store tool result memories
            tool_results = []
            for m in self.messages:
                if m.get("role") == "tool":
                    content = m.get("content", "")
                    auto_remember_turn("tool", str(content), success)
                    tool_results.append({"content": str(content)[:500], "is_error": False})

            # Auto-skill generation for complex tasks
            if tool_count >= 3 and success:
                tool_call_list = []
                for m in self.messages:
                    if m.get("role") == "assistant" and m.get("tool_calls"):
                        for tc in m["tool_calls"]:
                            fn = tc.get("function", {})
                            try:
                                args = json.loads(fn.get("arguments", "{}"))
                            except Exception:
                                args = {}
                            tool_call_list.append({"name": fn.get("name", ""), "arguments": args})
                skill_name = maybe_generate_skill(
                    self.session_id, user_message, tool_call_list, success
                )
                if skill_name and self.verbose:
                    print(f"  [Brain] Auto-generated skill: {skill_name}", file=sys.stderr)

            # Run comprehensive auto-learning engine
            learnings = auto_learn_from_chat(
                messages=self.messages,
                user_message=user_message,
                final_response=final_response or "",
                tools_used=tools_used,
                tool_results=tool_results,
                success=success,
                session_id=self.session_id,
            )
            
            if self.verbose and any(learnings.get(k) for k in 
                ["skills_extracted", "knowledge_extracted", "lessons_learned"]):
                print(f"  [Auto-Learn] Skills: {len(learnings.get('skills_extracted', []))}, "
                      f"Knowledge: {len(learnings.get('knowledge_extracted', []))}, "
                      f"Lessons: {len(learnings.get('lessons_learned', []))}", 
                      file=sys.stderr)

        except Exception as e:
            if self.verbose:
                print(f"  [Brain] Error: {e}", file=sys.stderr)

        return final_response

    # -- model fallback ---------------------------------------------------

    @staticmethod
    def _normalize_model(model: str) -> str:
        """Strip client-style 'openrouter/' prefix; the API wants bare slugs."""
        if model.startswith("openrouter/"):
            return model[len("openrouter/"):]
        return model

    def _is_retriable_error(self, error: Exception) -> bool:
        """Check if an API error is retriable."""
        err_str = str(error).lower()
        retriable = ["429", "402", "500", "502", "503", "rate limit", "insufficient", "overloaded", "timeout"]
        return any(code in err_str or phrase in err_str for code, phrase in [(r, r) for r in retriable])

    def _call_with_fallback(self, messages, stream=True, on_token=None, on_thinking=None):
        """Try primary model, fall back to alternatives on failure."""
        models_to_try = [self._normalize_model(m) for m in
                         [self.model] + [m for m in self.fallback_models if m != self.model]]
        last_error = None
        for model in models_to_try:
            try:
                if self.verbose and model != self.model:
                    print(f"  [Fallback] Trying {model}...", file=sys.stderr)
                if stream:
                    text, calls, usage = self._call_streaming(messages, on_token, on_thinking, model=model)
                else:
                    text, calls, usage = self._call_non_streaming(messages, model=model)
                return text, calls, model, usage
            except Exception as e:
                last_error = e
                if self._is_retriable_error(e):
                    logger.warning("Model %s failed (retriable): %s", model, e)
                    continue
                else:
                    logger.error("Model %s failed (non-retriable): %s", model, e)
                    raise
        logger.error("All models failed. Last error: %s", last_error)
        return None, [], self.model, {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

    def _call_streaming(self, messages, on_token=None, on_thinking=None, model: str = ""):
        """Call OpenRouter with streaming."""
        kwargs: Dict[str, Any] = {
            "model": model or self.model,
            "messages": messages,
            "stream": True,
        }
        if self.max_tokens > 0:
            kwargs["max_tokens"] = self.max_tokens
        if self.tools:
            kwargs["tools"] = self.tools
            kwargs["tool_choice"] = "auto"
        stream_resp = self.client.chat.completions.create(**kwargs)
        response_text = ""
        tool_calls: List[Dict] = []
        usage_data = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        for chunk in stream_resp:
            delta = chunk.choices[0].delta if chunk.choices else None
            if not delta:
                continue
            if delta.content:
                response_text += delta.content
                if on_token:
                    on_token(delta.content)
                    # Human delay simulation for natural pacing
                    if self.human_delay > 0:
                        time.sleep(self.human_delay)
            # Capture reasoning/thinking tokens (OpenRouter, Anthropic, etc.)
            if on_thinking:
                if hasattr(delta, 'reasoning') and delta.reasoning:
                    on_thinking(delta.reasoning)
                if hasattr(delta, 'reasoning_details') and delta.reasoning_details:
                    for detail in delta.reasoning_details:
                        if hasattr(detail, 'text') and detail.text:
                            on_thinking(detail.text)
            if delta.tool_calls:
                for tc_delta in delta.tool_calls:
                    idx = tc_delta.index
                    while len(tool_calls) <= idx:
                        tool_calls.append({
                            "id": "",
                            "type": "function",
                            "function": {"name": "", "arguments": ""},
                        })
                    if tc_delta.id:
                        tool_calls[idx]["id"] = tc_delta.id
                    if tc_delta.function:
                        if tc_delta.function.name:
                            tool_calls[idx]["function"]["name"] = tc_delta.function.name
                        if tc_delta.function.arguments:
                            tool_calls[idx]["function"]["arguments"] += tc_delta.function.arguments
            # Capture usage from final chunk
            if hasattr(chunk, 'usage') and chunk.usage:
                usage_data["prompt_tokens"] = chunk.usage.prompt_tokens or 0
                usage_data["completion_tokens"] = chunk.usage.completion_tokens or 0
                usage_data["total_tokens"] = chunk.usage.total_tokens or 0
        return response_text, tool_calls, usage_data

    def _call_non_streaming(self, messages, model: str = ""):
        """Call OpenRouter without streaming."""
        kwargs: Dict[str, Any] = {
            "model": model or self.model,
            "messages": messages,
        }
        if self.max_tokens > 0:
            kwargs["max_tokens"] = self.max_tokens
        if self.tools:
            kwargs["tools"] = self.tools
            kwargs["tool_choice"] = "auto"
        response = self.client.chat.completions.create(**kwargs)
        msg = response.choices[0].message
        text = msg.content or ""
        tool_calls = []
        if msg.tool_calls:
            tool_calls = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
                for tc in msg.tool_calls
            ]
        usage_data = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        if hasattr(response, 'usage') and response.usage:
            usage_data["prompt_tokens"] = response.usage.prompt_tokens or 0
            usage_data["completion_tokens"] = response.usage.completion_tokens or 0
            usage_data["total_tokens"] = response.usage.total_tokens or 0
        return text, tool_calls, usage_data
