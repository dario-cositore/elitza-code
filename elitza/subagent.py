"""Elitza subagent system -- spawn isolated child agents for parallel work.

Isolated child agents spawned as subprocesses:
  - Child agents run as isolated Python subprocesses
  - Each child gets its own system prompt + tools + persona
  - Parent waits for result with configurable timeout
  - Results returned as JSON

Design: intentionally small -- same core pattern, subprocess isolation.
"""

import json
import logging
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Subagent personas -- system prompt overrides for different roles
PERSONAS = {
    "implementer": """You are an implementer subagent. Your job is to write code.
Follow these rules:
- Write clean, correct, idiomatic code
- Use the project's existing patterns and conventions
- Make minimal, focused changes
- Always verify your changes work before finishing
- Report what you changed and why""",

    "reviewer": """You are a code reviewer subagent. Your job is to review code quality.
Follow these rules:
- Check for bugs, security issues, and edge cases
- Verify error handling is correct
- Check for performance issues
- Verify tests pass
- Provide specific, actionable feedback
- Report: APPROVED or list of issues found""",

    "researcher": """You are a research subagent. Your job is to investigate and report findings.
Follow these rules:
- Thoroughly explore the relevant code/files
- Gather all relevant information
- Report findings clearly and concisely
- Do not make any code changes
- Focus on understanding, not fixing""",

    "tester": """You are a test writer subagent. Your job is to write and run tests.
Follow these rules:
- Write comprehensive tests covering edge cases
- Follow the project's testing conventions
- Run the tests and report results
- Fix any test failures before finishing
- Report: ALL PASS or list of failures""",

    "security-auditor": """You are a security auditor subagent. Your job is to find vulnerabilities.
Follow these rules:
- Check for OWASP top 10 vulnerabilities
- Look for injection, XSS, CSRF, auth bypass
- Check for hardcoded secrets or credentials
- Verify input validation and sanitization
- Report: SECURE or list of vulnerabilities with severity""",
}


def spawn_subagent(
    task: str,
    persona: str = "implementer",
    tools: Optional[List[str]] = None,
    cwd: Optional[str] = None,
    timeout: int = 0,
    model: str = "",
    api_key: str = "",
    max_tokens: int = 128000,
) -> Dict[str, Any]:
    """Spawn an isolated subagent as a subprocess.

    Args:
        task: The task description for the subagent
        persona: Role persona (implementer, reviewer, researcher, tester, security-auditor)
        tools: List of tool names to enable (None = all)
        cwd: Working directory for the subagent
        timeout: Max seconds to wait for result (0 = no limit)
        model: Model override
        api_key: OpenRouter API key
        max_tokens: Max tokens per response

    Returns:
        Dict with keys: status (success|timeout|error), result, duration
    """
    run_id = str(uuid.uuid4())[:8]
    start = time.monotonic()

    # Build the subagent script
    script = _build_subagent_script(task, persona, tools or [], model, max_tokens)

    # Write to temp file
    script_path = Path(tempfile.gettempdir()) / f"elitza-subagent-{run_id}.py"
    script_path.write_text(script)

    env = os.environ.copy()
    if api_key:
        env["OPENROUTER_API_KEY"] = api_key
    if cwd:
        env["ELITZA_SUBAGENT_CWD"] = cwd

    try:
        result = subprocess.run(
            [sys.executable, str(script_path)],
            capture_output=True,
            text=True,
            timeout=timeout if timeout > 0 else None,
            env=env,
            cwd=cwd or os.getcwd(),
        )
        duration = time.monotonic() - start

        if result.returncode != 0:
            stderr = result.stderr.strip()[:500] if result.stderr else "Unknown error"
            logger.error("Subagent %s failed (exit %d): %s", run_id, result.returncode, stderr)
            return {
                "status": "error",
                "result": stderr,
                "duration": duration,
                "run_id": run_id,
            }

        stdout = result.stdout.strip()
        # Try to parse as JSON
        try:
            data = json.loads(stdout)
            data["duration"] = duration
            data["run_id"] = run_id
            return data
        except json.JSONDecodeError:
            return {
                "status": "success",
                "result": stdout,
                "duration": duration,
                "run_id": run_id,
            }

    except subprocess.TimeoutExpired:
        duration = time.monotonic() - start
        logger.warning("Subagent %s timed out after %ds", run_id, timeout)
        return {
            "status": "timeout",
            "result": f"Subagent timed out after {timeout}s",
            "duration": duration,
            "run_id": run_id,
        }
    except Exception as e:
        duration = time.monotonic() - start
        logger.error("Subagent %s error: %s", run_id, e)
        return {
            "status": "error",
            "result": str(e),
            "duration": duration,
            "run_id": run_id,
        }
    finally:
        # Cleanup temp script
        try:
            script_path.unlink()
        except OSError:
            pass


def _build_subagent_script(
    task: str,
    persona: str,
    tools: list,
    model: str,
    max_tokens: int,
) -> str:
    """Build a self-contained Python script that runs a subagent."""
    persona_prompt = PERSONAS.get(persona, PERSONAS["implementer"])
    tools_json = json.dumps(tools)
    model_str = json.dumps(model) if model else "''"
    max_tokens_str = str(max_tokens)

    return f'''#!/usr/bin/env python3
"""Elitza subagent -- isolated child agent."""
import json
import os
import sys

# Minimal subagent implementation
TASK = {json.dumps(task)}
PERSONA = {json.dumps(persona)}
PERSONA_PROMPT = {json.dumps(persona_prompt)}
TOOLS = {tools_json}
MODEL = {model_str}
MAX_TOKENS = {max_tokens_str}

def main():
    try:
        import json
        from openai import OpenAI

        api_key = os.environ.get("OPENROUTER_API_KEY", "")
        if not api_key:
            print(json.dumps({{"status": "error", "result": "No OPENROUTER_API_KEY set"}}))
            sys.exit(1)

        client = OpenAI(
            api_key=api_key,
            base_url="https://openrouter.ai/api/v1",
        )

        # If model is empty, use a default
        model = MODEL or "inclusionai/ling-3.1-flash"

        system_prompt = f"You are a {{PERSONA}} subagent. {{PERSONA_PROMPT}}\\n\\nComplete this task:\\n{{TASK}}\\n\\nReport your result as JSON with keys: status (success/error), result (your findings/output)."

        messages = [
            {{"role": "system", "content": system_prompt}},
            {{"role": "user", "content": TASK}},
        ]

        # If the task needs file access, add it
        if any(kw in TASK.lower() for kw in ["read", "file", "code", "search", "find", "review", "test"]):
            cwd = os.environ.get("ELITZA_SUBAGENT_CWD", os.getcwd())
            messages.append({{
                "role": "user",
                "content": f"Working directory: {{cwd}}\\nUse the terminal tool (shell commands) and file tools to complete the task. Report findings as JSON."
            }})

        response = client.chat.completions.create(
            model=model,
            messages=messages,
            **({{}} if MAX_TOKENS <= 0 else {{"max_tokens": MAX_TOKENS}}),
        )

        result_text = response.choices[0].message.content

        # Try to extract JSON from the result
        try:
            # Look for JSON in the response
            start = result_text.find("{{")
            end = result_text.rfind("}}") + 1
            if start >= 0 and end > start:
                data = json.loads(result_text[start:end])
                print(json.dumps(data))
            else:
                print(json.dumps({{"status": "success", "result": result_text}}))
        except json.JSONDecodeError:
            print(json.dumps({{"status": "success", "result": result_text}}))

    except Exception as e:
        print(json.dumps({{"status": "error", "result": str(e)}}))
        sys.exit(1)

if __name__ == "__main__":
    main()
'''


def spawn_parallel(
    tasks: List[Dict[str, Any]],
    max_concurrency: int = 10,
    timeout: int = 0,
) -> List[Dict[str, Any]]:
    """Spawn multiple subagents in parallel using threads.

    Args:
        tasks: List of kwargs dicts for spawn_subagent
        max_concurrency: Max parallel subagents
        timeout: Per-subagent timeout (0 = no limit)

    Returns:
        List of result dicts
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    results = []

    with ThreadPoolExecutor(max_workers=max_concurrency) as executor:
        futures = {}
        for task_kwargs in tasks:
            task_kwargs.setdefault("timeout", timeout)
            future = executor.submit(spawn_subagent, **task_kwargs)
            futures[future] = task_kwargs.get("task", "?")

        for future in as_completed(futures, timeout=timeout + 10):
            task_desc = futures[future]
            try:
                result = future.result()
                result["task"] = task_desc
                results.append(result)
            except Exception as e:
                results.append({
                    "status": "error",
                    "result": str(e),
                    "task": task_desc,
                })

    return results
