"""Elitza Auto-Learning Engine -- Extracts skills, knowledge, and lessons from every chat.

This module runs after every conversation turn and:
1. Compresses the conversation into key takeaways
2. Extracts new skills from tool usage patterns
3. Pulls out facts, rules, and best practices
4. Captures mistakes and how they were fixed
5. Stores compressed conversation memory

The goal: Every chat makes Elitza smarter. Nothing is wasted.
"""

import json
import logging
import re
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from elitza.constants import get_elitza_home

logger = logging.getLogger(__name__)

BRAIN = get_elitza_home() / "brain"
SKILLS_DIR = BRAIN / "procedural"
CONVERSATIONS_DIR = BRAIN / "conversations"

# Ensure directories exist
SKILLS_DIR.mkdir(parents=True, exist_ok=True)
CONVERSATIONS_DIR.mkdir(parents=True, exist_ok=True)


# ===========================================================================
# Main Auto-Learning Pipeline
# ===========================================================================

def auto_learn_from_chat(messages: List[Dict], user_message: str, 
                         final_response: str, tools_used: List[str],
                         tool_results: List[Dict], success: bool,
                         session_id: str) -> Dict:
    """Main entry point: Extract everything learnable from a chat turn.
    
    Returns a summary of what was learned.
    """
    from elitza.brain_v2 import (
        store_episodic, store_semantic, store_procedural,
        store_emotional, _soul_set
    )
    
    learnings = {
        "skills_extracted": [],
        "knowledge_extracted": [],
        "lessons_learned": [],
        "conversation_compressed": False,
        "emotional_events": [],
    }
    
    # 1. Extract skills from tool usage
    skills = _extract_skills_from_tools(
        user_message, final_response, tools_used, tool_results, success
    )
    for skill in skills:
        store_procedural(
            skill["name"],
            steps=skill["steps"],
            context=skill["context"],
            importance=skill.get("importance", 0.7)
        )
        learnings["skills_extracted"].append(skill["name"])
    
    # 2. Extract knowledge (facts, rules, best practices)
    knowledge = _extract_knowledge(
        user_message, final_response, tools_used, tool_results
    )
    for fact in knowledge:
        store_semantic(
            fact["content"],
            source=f"chat_extract:{fact['type']}",
            importance=fact.get("importance", 0.7),
            tags=fact.get("tags", [])
        )
        learnings["knowledge_extracted"].append(fact["type"])
    
    # 3. Extract lessons (mistakes and fixes)
    lessons = _extract_lessons(
        user_message, final_response, tool_results, success
    )
    for lesson in lessons:
        store_episodic(
            f"[LESSON] {lesson['content']}",
            importance=lesson.get("importance", 0.8),
            tags=["lesson", lesson.get("category", "general")]
        )
        learnings["lessons_learned"].append(lesson.get("category", "general"))
    
    # 4. Detect and store emotional events
    emotions = _detect_emotional_events(user_message, final_response, success)
    for emotion in emotions:
        store_emotional(
            emotion["event"],
            valence=emotion["valence"],
            arousal=emotion["arousal"],
            mood=emotion["mood"],
            context=f"session:{session_id}"
        )
        learnings["emotional_events"].append(emotion["mood"])
    
    # 5. Compress and store conversation
    if len(messages) > 2:
        compressed = _compress_conversation(
            messages, user_message, final_response, session_id
        )
        if compressed:
            learnings["conversation_compressed"] = True
            # Store as episodic memory
            store_episodic(
                f"[CONVERSATION] {compressed['summary']}",
                importance=0.6,
                tags=["conversation", "compressed", session_id[:8]]
            )
    
    # 6. Update learning stats
    _update_learning_stats(learnings)
    
    return learnings


# ===========================================================================
# Skill Extraction from Tool Usage
# ===========================================================================

def _extract_skills_from_tools(user_msg: str, response: str, 
                               tools_used: List[str], 
                               tool_results: List[Dict],
                               success: bool) -> List[Dict]:
    """Extract reusable skills from tool usage patterns."""
    skills = []
    
    if not tools_used or not success:
        return skills
    
    # Pattern 1: Tool chains (sequence of related tools)
    tool_chain = _detect_tool_chain(tools_used, tool_results)
    if tool_chain:
        skills.append(tool_chain)
    
    # Pattern 2: New tool combinations
    combo_skill = _detect_tool_combination(tools_used, user_msg)
    if combo_skill:
        skills.append(combo_skill)
    
    # Pattern 3: Successful problem-solving patterns
    problem_skill = _detect_problem_solving_pattern(
        user_msg, response, tools_used, success
    )
    if problem_skill:
        skills.append(problem_skill)
    
    # Pattern 4: File/code manipulation patterns
    code_skill = _detect_code_pattern(user_msg, response, tools_used)
    if code_skill:
        skills.append(code_skill)
    
    return skills


def _detect_tool_chain(tools: List[str], results: List[Dict]) -> Optional[Dict]:
    """Detect a meaningful chain of tool calls."""
    if len(tools) < 2:
        return None
    
    # Count tool frequencies
    tool_counts = {}
    for t in tools:
        tool_counts[t] = tool_counts.get(t, 0) + 1
    
    # Create a skill from the chain
    chain_desc = " → ".join(dict.fromkeys(tools))  # Unique, ordered
    
    # Check if we already have this skill
    skill_id = hashlib.md5(chain_desc.encode()).hexdigest()[:12]
    skill_path = SKILLS_DIR / f"chain-{skill_id}.md"
    
    if skill_path.exists():
        return None  # Already have this skill
    
    # Determine importance based on chain length and success
    importance = min(0.9, 0.5 + len(tools) * 0.1)
    
    return {
        "name": f"tool-chain-{skill_id}",
        "steps": [
            f"Tool chain: {chain_desc}",
            f"Tools used: {json.dumps(tool_counts)}",
        ],
        "context": f"Automatically detected tool chain pattern",
        "importance": importance,
        "type": "tool_chain",
    }


def _detect_tool_combination(tools: List[str], user_msg: str) -> Optional[Dict]:
    """Detect a useful combination of tools for a specific task type."""
    tool_set = set(tools)
    
    # Common useful combinations
    combinations = {
        frozenset(["read_file", "write_file", "shell_exec"]): 
            "file-edit-execute",
        frozenset(["read_file", "patch", "shell_exec"]): 
            "patch-and-test",
        frozenset(["web_search", "web_fetch", "write_file"]): 
            "research-and-document",
        frozenset(["read_file", "shell_exec", "write_file"]): 
            "read-modify-write",
        frozenset(["shell_exec", "read_file"]): 
            "execute-and-verify",
    }
    
    for combo_tools, combo_name in combinations.items():
        if combo_tools.issubset(tool_set):
            return {
                "name": f"combo-{combo_name}",
                "steps": [f"Combination pattern: {combo_name}"],
                "context": f"Detected from task: {user_msg[:100]}",
                "importance": 0.6,
                "type": "tool_combination",
            }
    
    return None


def _detect_problem_solving_pattern(user_msg: str, response: str,
                                    tools: List[str], success: bool) -> Optional[Dict]:
    """Detect successful problem-solving patterns."""
    # Look for error-fix patterns
    error_indicators = ["error", "failed", "broken", "fix", "issue", "bug"]
    fix_indicators = ["fixed", "resolved", "worked", "solved", "corrected"]
    
    has_error_mention = any(ind in user_msg.lower() for ind in error_indicators)
    has_fix_mention = any(ind in response.lower() for ind in fix_indicators)
    
    if has_error_mention and has_fix_mention and success:
        return {
            "name": "problem-solving-pattern",
            "steps": [
                f"Problem: {user_msg[:100]}",
                f"Solution approach: used {', '.join(tools[:3])}",
                f"Result: Success"
            ],
            "context": "Error resolution pattern",
            "importance": 0.75,
            "type": "problem_solving",
        }
    
    return None


def _detect_code_pattern(user_msg: str, response: str, 
                         tools: List[str]) -> Optional[Dict]:
    """Detect code manipulation patterns."""
    code_indicators = ["code", "function", "class", "import", "def ", "class ", 
                       "python", "rust", "javascript", "typescript"]
    
    has_code_context = any(ind in user_msg.lower() for ind in code_indicators)
    has_code_tools = bool(set(tools) & {"write_file", "patch", "read_file"})
    
    if has_code_context and has_code_tools:
        # Determine language
        language = "unknown"
        for lang in ["python", "rust", "javascript", "typescript", "go"]:
            if lang in user_msg.lower():
                language = lang
                break
        
        return {
            "name": f"code-pattern-{language}",
            "steps": [f"Code manipulation pattern for {language}"],
            "context": f"Detected from: {user_msg[:80]}",
            "importance": 0.65,
            "type": "code_pattern",
        }
    
    return None


# ===========================================================================
# Knowledge Extraction
# ===========================================================================

def _extract_knowledge(user_msg: str, response: str, 
                       tools: List[str], results: List[Dict]) -> List[Dict]:
    """Extract facts, rules, and best practices from the conversation."""
    knowledge = []
    
    # Extract from user message
    user_knowledge = _extract_from_text(user_msg, "user_stated")
    knowledge.extend(user_knowledge)
    
    # Extract from assistant response
    response_knowledge = _extract_from_text(response, "assistant_explained")
    knowledge.extend(response_knowledge)
    
    # Extract from tool results
    for result in results:
        if isinstance(result, dict) and result.get("content"):
            result_knowledge = _extract_from_text(
                result["content"], "tool_result"
            )
            knowledge.extend(result_knowledge)
    
    # Extract configuration/settings knowledge
    config_knowledge = _extract_config_knowledge(user_msg, response)
    knowledge.extend(config_knowledge)
    
    return knowledge


def _extract_from_text(text: str, source: str) -> List[Dict]:
    """Extract knowledge from text using pattern matching."""
    knowledge = []
    
    if not text:
        return knowledge
    
    # Pattern 1: Definitions ("X is Y", "X means Y")
    definition_patterns = [
        r"(?:the|a|an)\s+(\w[\w\s]*?)\s+(?:is|are|was|were)\s+(?:a|an|the)?\s*(.+?)(?:\.|$)",
        r"(\w[\w\s]*?)\s+(?:means|refers to|indicates)\s+(.+?)(?:\.|$)",
    ]
    
    for pattern in definition_patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for match in matches:
            if len(match[0]) > 3 and len(match[1]) > 10:
                knowledge.append({
                    "content": f"[DEFINITION] {match[0].strip()} is {match[1].strip()}",
                    "type": "definition",
                    "importance": 0.7,
                    "tags": ["definition", source],
                })
    
    # Pattern 2: Rules ("always do X", "never do Y", "don't do Z")
    rule_patterns = [
        r"(?:always|definitely|make sure to)\s+(.+?)(?:\.|$)",
        r"(?:never|don't|do not|avoid)\s+(.+?)(?:\.|$)",
        r"(?:must|should|need to)\s+(.+?)(?:\.|$)",
    ]
    
    for pattern in rule_patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for match in matches:
            if len(match) > 10:
                knowledge.append({
                    "content": f"[RULE] {match.strip()}",
                    "type": "rule",
                    "importance": 0.75,
                    "tags": ["rule", source],
                })
    
    # Pattern 3: Best practices ("the best way is X", "recommended approach")
    practice_patterns = [
        r"(?:best|recommended|preferred|optimal)\s+(?:way|approach|method)\s+(?:is|to)\s+(.+?)(?:\.|$)",
        r"(?:it's better to|you should|the right way is)\s+(.+?)(?:\.|$)",
    ]
    
    for pattern in practice_patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for match in matches:
            if len(match) > 10:
                knowledge.append({
                    "content": f"[BEST_PRACTICE] {match.strip()}",
                    "type": "best_practice",
                    "importance": 0.8,
                    "tags": ["best_practice", source],
                })
    
    # Pattern 4: Technical facts (file paths, commands, configurations)
    tech_patterns = [
        r"(?:the file|config|setting)\s+(?:is|at|located)\s+(.+?)(?:\.|$)",
        r"(?:run|execute|use)\s+(?:the command|cmd)\s+(.+?)(?:\.|$)",
    ]
    
    for pattern in tech_patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for match in matches:
            if len(match) > 5:
                knowledge.append({
                    "content": f"[TECHNICAL] {match.strip()}",
                    "type": "technical",
                    "importance": 0.65,
                    "tags": ["technical", source],
                })
    
    return knowledge


def _extract_config_knowledge(user_msg: str, response: str) -> List[Dict]:
    """Extract configuration and settings knowledge."""
    knowledge = []
    
    # Look for API keys, paths, configurations
    config_patterns = [
        (r"(?:api[_\s]?key|token)\s*[=:]\s*(.+?)(?:\s|$|,|\")", "api_key"),
        (r"(?:path|directory|folder)\s*[=:]\s*(.+?)(?:\s|$|,|\")", "path"),
        (r"(?:url|endpoint)\s*[=:]\s*(.+?)(?:\s|$|,|\")", "url"),
        (r"(?:port|number)\s*[=:]\s*(\d+)", "port"),
    ]
    
    combined_text = f"{user_msg} {response}"
    
    for pattern, config_type in config_patterns:
        matches = re.findall(pattern, combined_text, re.IGNORECASE)
        for match in matches:
            # Don't store actual secrets
            if any(sensitive in match.lower() for sensitive in 
                   ["password", "secret", "private"]):
                continue
            knowledge.append({
                "content": f"[CONFIG] {config_type}: {match.strip()[:100]}",
                "type": "config",
                "importance": 0.6,
                "tags": ["config", config_type],
            })
    
    return knowledge


# ===========================================================================
# Lesson Extraction
# ===========================================================================

def _extract_lessons(user_msg: str, response: str, 
                     results: List[Dict], success: bool) -> List[Dict]:
    """Extract lessons from mistakes and how they were fixed."""
    lessons = []
    
    # Check for error-fix patterns
    has_error = any(r.get("is_error", False) for r in results if isinstance(r, dict))
    has_error_words = any(word in response.lower() for word in 
                         ["error", "failed", "exception", "traceback", "bug"])
    
    if has_error or has_error_words:
        lesson = {
            "content": f"Error encountered: {user_msg[:150]}",
            "category": "error_encounter",
            "importance": 0.7,
        }
        lessons.append(lesson)
    
    if success and (has_error or has_error_words):
        lesson = {
            "content": f"Successfully resolved: {response[:200]}",
            "category": "error_resolution",
            "importance": 0.8,
        }
        lessons.append(lesson)
    
    # Pattern: User correction
    correction_indicators = ["no, ", "wrong", "actually, ", "that's not", 
                            "incorrect", "should be", "meant "]
    if any(ind in user_msg.lower() for ind in correction_indicators):
        lesson = {
            "content": f"User correction: {user_msg[:200]}",
            "category": "user_correction",
            "importance": 0.85,
        }
        lessons.append(lesson)
    
    # Pattern: Learning from failure
    if not success:
        lesson = {
            "content": f"Task failed: {user_msg[:150]}. Response: {response[:150]}",
            "category": "failure_analysis",
            "importance": 0.75,
        }
        lessons.append(lesson)
    
    return lessons


# ===========================================================================
# Emotional Event Detection
# ===========================================================================

def _detect_emotional_events(user_msg: str, response: str, 
                             success: bool) -> List[Dict]:
    """Detect emotional events in the conversation."""
    events = []
    
    # User emotions
    user_emotions = {
        "excited": ["amazing", "awesome", "great", "love", "perfect", "excellent", "brilliant"],
        "frustrated": ["stuck", "broken", "error", "failed", "wrong", "hate", "annoying", "damn"],
        "grateful": ["thanks", "thank you", "appreciate", "grateful", "helpful"],
        "curious": ["how", "why", "what if", "wonder", "curious", "explore"],
        "urgent": ["now", "asap", "quickly", "urgent", "immediately", "hurry", "need"],
        "disappointed": ["disappointed", "letdown", "expected", " hoped", "wanted"],
    }
    
    for emotion, keywords in user_emotions.items():
        if any(kw in user_msg.lower() for kw in keywords):
            valence_map = {
                "excited": 0.8, "frustrated": -0.6, "grateful": 0.7,
                "curious": 0.3, "urgent": -0.2, "disappointed": -0.5
            }
            arousal_map = {
                "excited": 0.9, "frustrated": 0.8, "grateful": 0.5,
                "curious": 0.6, "urgent": 0.9, "disappointed": 0.3
            }
            
            events.append({
                "event": f"User expressed {emotion}: {user_msg[:100]}",
                "valence": valence_map.get(emotion, 0.0),
                "arousal": arousal_map.get(emotion, 0.5),
                "mood": emotion,
            })
    
    # Success/failure emotions
    if success:
        events.append({
            "event": "Task completed successfully",
            "valence": 0.6,
            "arousal": 0.4,
            "mood": "accomplished",
        })
    else:
        events.append({
            "event": "Task failed or incomplete",
            "valence": -0.4,
            "arousal": 0.6,
            "mood": "determined",
        })
    
    return events


# ===========================================================================
# Conversation Compression
# ===========================================================================

def _compress_conversation(messages: List[Dict], user_msg: str, 
                           response: str, session_id: str) -> Optional[Dict]:
    """Compress a conversation into key takeaways."""
    if len(messages) < 3:
        return None
    
    # Extract key elements
    user_topics = _extract_topics(user_msg)
    tools_used = []
    for m in messages:
        if m.get("role") == "assistant" and m.get("tool_calls"):
            for tc in m["tool_calls"]:
                fn = tc.get("function", {})
                tools_used.append(fn.get("name", ""))
    
    # Create summary
    summary_parts = []
    if user_topics:
        summary_parts.append(f"Topic: {', '.join(user_topics[:3])}")
    if tools_used:
        unique_tools = list(dict.fromkeys(tools_used))[:5]
        summary_parts.append(f"Tools: {', '.join(unique_tools)}")
    
    summary = "; ".join(summary_parts) if summary_parts else f"Chat about: {user_msg[:50]}"
    
    # Store compressed conversation
    conv_file = CONVERSATIONS_DIR / f"{session_id[:16]}.json"
    conv_data = {
        "session_id": session_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "summary": summary,
        "topics": user_topics,
        "tools_used": tools_used,
        "message_count": len(messages),
        "user_message_preview": user_msg[:200],
        "response_preview": response[:200] if response else "",
    }
    
    try:
        conv_file.write_text(json.dumps(conv_data, indent=2))
    except Exception as e:
        logger.warning(f"Failed to write conversation: {e}")
    
    return conv_data


def _extract_topics(text: str) -> List[str]:
    """Extract main topics from text."""
    topics = []
    
    # Common topic indicators
    topic_patterns = [
        (r"(?:about|regarding|concerning|on)\s+(.+?)(?:\.|,|\?|$)", "topic"),
        (r"(?:help|assist|fix|solve|build|create|implement)\s+(.+?)(?:\.|,|\?|$)", "task"),
    ]
    
    for pattern, topic_type in topic_patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for match in matches:
            topic = match.strip()[:50]
            if len(topic) > 3:
                topics.append(topic)
    
    # Fallback: extract nouns/important words
    if not topics:
        words = text.split()
        # Simple heuristic: words longer than 4 chars that aren't common
        common_words = {"this", "that", "with", "from", "have", "been", "were", 
                       "they", "their", "what", "when", "where", "which", "about"}
        topics = [w for w in words if len(w) > 4 and w.lower() not in common_words][:3]
    
    return topics


# ===========================================================================
# Learning Stats
# ===========================================================================

def _update_learning_stats(learnings: Dict):
    """Update learning statistics in the soul."""
    from elitza.brain_v2 import _soul_get, _soul_set
    
    stats = json.loads(_soul_get("learning_stats", "{}"))
    
    # Update counts
    stats["total_skills"] = stats.get("total_skills", 0) + len(learnings.get("skills_extracted", []))
    stats["total_knowledge"] = stats.get("total_knowledge", 0) + len(learnings.get("knowledge_extracted", []))
    stats["total_lessons"] = stats.get("total_lessons", 0) + len(learnings.get("lessons_learned", []))
    stats["total_conversations"] = stats.get("total_conversations", 0) + (1 if learnings.get("conversation_compressed") else 0)
    
    # Track recent learning
    recent = stats.get("recent", [])
    recent.append({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "skills": len(learnings.get("skills_extracted", [])),
        "knowledge": len(learnings.get("knowledge_extracted", [])),
        "lessons": len(learnings.get("lessons_learned", [])),
    })
    stats["recent"] = recent[-20:]  # Keep last 20
    
    _soul_set("learning_stats", json.dumps(stats))


def get_learning_stats() -> Dict:
    """Get learning statistics."""
    from elitza.brain_v2 import _soul_get
    
    stats = json.loads(_soul_get("learning_stats", "{}"))
    
    return {
        "total_skills": stats.get("total_skills", 0),
        "total_knowledge": stats.get("total_knowledge", 0),
        "total_lessons": stats.get("total_lessons", 0),
        "total_conversations": stats.get("total_conversations", 0),
        "recent_activity": stats.get("recent", [])[-5:],
    }
