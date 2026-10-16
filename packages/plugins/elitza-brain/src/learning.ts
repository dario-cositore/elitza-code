/**
 * Elitza Brain — auto-learning pipeline.
 *
 * 1:1 port of the legacy Python `auto_learning.py`: every completed turn is
 * mined for skills, knowledge, lessons, and emotional events, the
 * conversation is compressed to a takeaway summary, and learning statistics
 * accumulate in the soul. "Every chat makes Elitza smarter."
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { BRAIN_DIR } from "./db.js"
import { storeEmotional, storeEpisodic, storeProcedural, storeSemantic } from "./memory.js"
import { soulGet, soulSet } from "./soul.js"

const SKILLS_DIR = path.join(BRAIN_DIR, "procedural")
const CONVERSATIONS_DIR = path.join(BRAIN_DIR, "conversations")

export interface ToolRun {
  name: string
  ok: boolean
  output: string
}

export interface Learnings {
  skills_extracted: string[]
  knowledge_extracted: string[]
  lessons_learned: string[]
  conversation_compressed: boolean
  emotional_events: string[]
}

// ---------------------------------------------------------------------------
// Main pipeline — runs once per completed turn (finalize)
// ---------------------------------------------------------------------------

export function runAutoLearn(input: {
  sessionID: string
  userText: string
  response: string
  tools: string[]
  toolRuns: ToolRun[]
  success: boolean
  messageCount: number
}): Learnings {
  const learnings: Learnings = {
    skills_extracted: [],
    knowledge_extracted: [],
    lessons_learned: [],
    conversation_compressed: false,
    emotional_events: [],
  }

  // 1. Extract skills from tool usage patterns
  for (const skill of extractSkillsFromTools(input.userText, input.response, input.tools, input.success)) {
    storeProcedural(skill.name, skill.steps, skill.context, skill.importance)
    learnings.skills_extracted.push(skill.name)
  }

  // 2. Extract knowledge (facts, rules, best practices)
  for (const fact of extractKnowledge(input.userText, input.response, input.toolRuns)) {
    storeSemantic(fact.content, {
      source: `chat_extract:${fact.type}`,
      importance: fact.importance,
      tags: fact.tags,
    })
    learnings.knowledge_extracted.push(fact.type)
  }

  // 3. Extract lessons (mistakes and fixes)
  for (const lesson of extractLessons(input.userText, input.response, input.toolRuns, input.success)) {
    storeEpisodic(`[LESSON] ${lesson.content}`, {
      importance: lesson.importance,
      tags: ["lesson", lesson.category],
    })
    learnings.lessons_learned.push(lesson.category)
  }

  // 4. Detect and store emotional events
  for (const emotion of detectEmotionalEvents(input.userText, input.response, input.success)) {
    storeEmotional(emotion.event, emotion.valence, emotion.arousal, emotion.mood, `session:${input.sessionID}`)
    learnings.emotional_events.push(emotion.mood)
  }

  // 5. Compress and store the conversation
  if (input.messageCount > 2) {
    const compressed = compressConversation(input)
    if (compressed) {
      learnings.conversation_compressed = true
      storeEpisodic(`[CONVERSATION] ${compressed.summary}`, {
        importance: 0.6,
        tags: ["conversation", "compressed", input.sessionID.slice(0, 8)],
      })
    }
  }

  // 6. Update learning statistics in the soul
  updateLearningStats(learnings)
  return learnings
}

// ---------------------------------------------------------------------------
// Skill extraction from tool usage (4 legacy detectors)
// ---------------------------------------------------------------------------

interface Skill {
  name: string
  steps: string[]
  context: string
  importance: number
}

function extractSkillsFromTools(
  userMsg: string,
  response: string,
  tools: string[],
  success: boolean,
): Skill[] {
  if (tools.length === 0 || !success) return []

  const skills: Skill[] = []

  // Pattern 1: Tool chains (sequence of related tools)
  const chain = detectToolChain(tools)
  if (chain) skills.push(chain)

  // Pattern 2: New tool combinations
  const combo = detectToolCombination(tools, userMsg)
  if (combo) skills.push(combo)

  // Pattern 3: Successful problem-solving patterns
  const problem = detectProblemSolvingPattern(userMsg, response, tools, success)
  if (problem) skills.push(problem)

  // Pattern 4: File/code manipulation patterns
  const code = detectCodePattern(userMsg, tools)
  if (code) skills.push(code)

  return skills
}

function detectToolChain(tools: string[]): Skill | null {
  if (tools.length < 2) return null

  const toolCounts: Record<string, number> = {}
  for (const t of tools) toolCounts[t] = (toolCounts[t] ?? 0) + 1
  const chainDesc = [...new Set(tools)].join(" → ")

  // Legacy dedup: a chain-<hash>.md skill file marks the pattern as learned.
  const skillID = crypto.createHash("md5").update(chainDesc).digest("hex").slice(0, 12)
  if (fs.existsSync(path.join(SKILLS_DIR, `chain-${skillID}.md`))) return null

  return {
    name: `tool-chain-${skillID}`,
    steps: [`Tool chain: ${chainDesc}`, `Tools used: ${JSON.stringify(toolCounts)}`],
    context: "Automatically detected tool chain pattern",
    importance: Math.min(0.9, 0.5 + tools.length * 0.1),
  }
}

function detectToolCombination(tools: string[], userMsg: string): Skill | null {
  const toolSet = new Set(tools)

  // Legacy combos remapped to the engine's tool names. The legacy table also
  // listed {read,shell,write} twice (read-modify-write ≡ file-edit-execute);
  // only distinct sets are kept — the first match always won.
  const combinations: [string[], string][] = [
    [["read", "write", "shell"], "file-edit-execute"],
    [["read", "edit", "shell"], "patch-and-test"],
    [["webfetch", "websearch", "write"], "research-and-document"],
    [["shell", "read"], "execute-and-verify"],
  ]

  for (const [comboTools, comboName] of combinations) {
    if (comboTools.every((t) => toolSet.has(t))) {
      return {
        name: `combo-${comboName}`,
        steps: [`Combination pattern: ${comboName}`],
        context: `Detected from task: ${userMsg.slice(0, 100)}`,
        importance: 0.6,
      }
    }
  }
  return null
}

function detectProblemSolvingPattern(userMsg: string, response: string, tools: string[], success: boolean): Skill | null {
  const errorIndicators = ["error", "failed", "broken", "fix", "issue", "bug"]
  const fixIndicators = ["fixed", "resolved", "worked", "solved", "corrected"]

  const hasErrorMention = errorIndicators.some((ind) => userMsg.toLowerCase().includes(ind))
  const hasFixMention = fixIndicators.some((ind) => response.toLowerCase().includes(ind))

  if (hasErrorMention && hasFixMention && success) {
    return {
      name: "problem-solving-pattern",
      steps: [
        `Problem: ${userMsg.slice(0, 100)}`,
        `Solution approach: used ${tools.slice(0, 3).join(", ")}`,
        "Result: Success",
      ],
      context: "Error resolution pattern",
      importance: 0.75,
    }
  }
  return null
}

function detectCodePattern(userMsg: string, tools: string[]): Skill | null {
  const codeIndicators = [
    "code",
    "function",
    "class",
    "import",
    "def ",
    "python",
    "rust",
    "javascript",
    "typescript",
  ]
  const hasCodeContext = codeIndicators.some((ind) => userMsg.toLowerCase().includes(ind))
  const hasCodeTools = tools.some((t) => ["write", "edit", "read"].includes(t))

  if (hasCodeContext && hasCodeTools) {
    const language = ["python", "rust", "javascript", "typescript", "go"].find((lang) =>
      userMsg.toLowerCase().includes(lang),
    )
    return {
      name: `code-pattern-${language ?? "unknown"}`,
      steps: [`Code manipulation pattern for ${language ?? "unknown"}`],
      context: `Detected from: ${userMsg.slice(0, 80)}`,
      importance: 0.65,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Knowledge extraction (definitions, rules, best practices, technical, config)
// ---------------------------------------------------------------------------

interface Fact {
  content: string
  type: string
  importance: number
  tags: string[]
}

function extractKnowledge(userMsg: string, response: string, toolRuns: ToolRun[]): Fact[] {
  const knowledge: Fact[] = []

  knowledge.push(...extractFromText(userMsg, "user_stated"))
  knowledge.push(...extractFromText(response, "assistant_explained"))
  for (const run of toolRuns) {
    if (run.output) knowledge.push(...extractFromText(run.output, "tool_result"))
  }
  knowledge.push(...extractConfigKnowledge(userMsg, response))

  return knowledge
}

function extractFromText(text: string, source: string): Fact[] {
  if (!text) return []
  const knowledge: Fact[] = []

  // Pattern 1: Definitions ("X is Y", "X means Y")
  const definitionPatterns = [
    /(?:the|a|an)\s+(\w[\w\s]*?)\s+(?:is|are|was|were)\s+(?:a|an|the)?\s*(.+?)(?:\.|$)/gi,
    /(\w[\w\s]*?)\s+(?:means|refers to|indicates)\s+(.+?)(?:\.|$)/gi,
  ]
  for (const pattern of definitionPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1].length > 3 && match[2].length > 10) {
        knowledge.push({
          content: `[DEFINITION] ${match[1].trim()} is ${match[2].trim()}`,
          type: "definition",
          importance: 0.7,
          tags: ["definition", source],
        })
      }
    }
  }

  // Pattern 2: Rules ("always do X", "never do Y", "don't do Z")
  const rulePatterns = [
    /(?:always|definitely|make sure to)\s+(.+?)(?:\.|$)/gi,
    /(?:never|don't|do not|avoid)\s+(.+?)(?:\.|$)/gi,
    /(?:must|should|need to)\s+(.+?)(?:\.|$)/gi,
  ]
  for (const pattern of rulePatterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1].length > 10) {
        knowledge.push({
          content: `[RULE] ${match[1].trim()}`,
          type: "rule",
          importance: 0.75,
          tags: ["rule", source],
        })
      }
    }
  }

  // Pattern 3: Best practices
  const practicePatterns = [
    /(?:best|recommended|preferred|optimal)\s+(?:way|approach|method)\s+(?:is|to)\s+(.+?)(?:\.|$)/gi,
    /(?:it's better to|you should|the right way is)\s+(.+?)(?:\.|$)/gi,
  ]
  for (const pattern of practicePatterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1].length > 10) {
        knowledge.push({
          content: `[BEST_PRACTICE] ${match[1].trim()}`,
          type: "best_practice",
          importance: 0.8,
          tags: ["best_practice", source],
        })
      }
    }
  }

  // Pattern 4: Technical facts (file paths, commands, configurations)
  const techPatterns = [
    /(?:the file|config|setting)\s+(?:is|at|located)\s+(.+?)(?:\.|$)/gi,
    /(?:run|execute|use)\s+(?:the command|cmd)\s+(.+?)(?:\.|$)/gi,
  ]
  for (const pattern of techPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1].length > 5) {
        knowledge.push({
          content: `[TECHNICAL] ${match[1].trim()}`,
          type: "technical",
          importance: 0.65,
          tags: ["technical", source],
        })
      }
    }
  }

  return knowledge
}

function extractConfigKnowledge(userMsg: string, response: string): Fact[] {
  const knowledge: Fact[] = []
  const configPatterns: [RegExp, string][] = [
    [/(?:api[_\s]?key|token)\s*[=:]\s*(.+?)(?:\s|$|,|")/gi, "api_key"],
    [/(?:path|directory|folder)\s*[=:]\s*(.+?)(?:\s|$|,|")/gi, "path"],
    [/(?:url|endpoint)\s*[=:]\s*(.+?)(?:\s|$|,|")/gi, "url"],
    [/(?:port|number)\s*[=:]\s*(\d+)/gi, "port"],
  ]
  const combined = `${userMsg} ${response}`

  for (const [pattern, configType] of configPatterns) {
    for (const match of combined.matchAll(pattern)) {
      // Never store actual secrets.
      if (["password", "secret", "private"].some((s) => match[1].toLowerCase().includes(s))) continue
      knowledge.push({
        content: `[CONFIG] ${configType}: ${match[1].trim().slice(0, 100)}`,
        type: "config",
        importance: 0.6,
        tags: ["config", configType],
      })
    }
  }
  return knowledge
}

// ---------------------------------------------------------------------------
// Lesson extraction (mistakes and how they were fixed)
// ---------------------------------------------------------------------------

interface Lesson {
  content: string
  category: string
  importance: number
}

function extractLessons(userMsg: string, response: string, toolRuns: ToolRun[], success: boolean): Lesson[] {
  const lessons: Lesson[] = []

  const hasError = toolRuns.some((r) => !r.ok)
  const hasErrorWords = ["error", "failed", "exception", "traceback", "bug"].some((word) =>
    response.toLowerCase().includes(word),
  )

  if (hasError || hasErrorWords) {
    lessons.push({
      content: `Error encountered: ${userMsg.slice(0, 150)}`,
      category: "error_encounter",
      importance: 0.7,
    })
  }

  if (success && (hasError || hasErrorWords)) {
    lessons.push({
      content: `Successfully resolved: ${response.slice(0, 200)}`,
      category: "error_resolution",
      importance: 0.8,
    })
  }

  const correctionIndicators = ["no, ", "wrong", "actually, ", "that's not", "incorrect", "should be", "meant "]
  if (correctionIndicators.some((ind) => userMsg.toLowerCase().includes(ind))) {
    lessons.push({
      content: `User correction: ${userMsg.slice(0, 200)}`,
      category: "user_correction",
      importance: 0.85,
    })
  }

  if (!success) {
    lessons.push({
      content: `Task failed: ${userMsg.slice(0, 150)}. Response: ${response.slice(0, 150)}`,
      category: "failure_analysis",
      importance: 0.75,
    })
  }

  return lessons
}

// ---------------------------------------------------------------------------
// Emotional event detection (stored as emotional memories)
// ---------------------------------------------------------------------------

interface EmotionalEvent {
  event: string
  valence: number
  arousal: number
  mood: string
}

function detectEmotionalEvents(userMsg: string, response: string, success: boolean): EmotionalEvent[] {
  void response
  const events: EmotionalEvent[] = []

  const userEmotions: Record<string, string[]> = {
    excited: ["amazing", "awesome", "great", "love", "perfect", "excellent", "brilliant"],
    frustrated: ["stuck", "broken", "error", "failed", "wrong", "hate", "annoying", "damn"],
    grateful: ["thanks", "thank you", "appreciate", "grateful", "helpful"],
    curious: ["how", "why", "what if", "wonder", "curious", "explore"],
    urgent: ["now", "asap", "quickly", "urgent", "immediately", "hurry", "need"],
    disappointed: ["disappointed", "letdown", "expected", " hoped", "wanted"],
  }
  const valenceMap: Record<string, number> = {
    excited: 0.8,
    frustrated: -0.6,
    grateful: 0.7,
    curious: 0.3,
    urgent: -0.2,
    disappointed: -0.5,
  }
  const arousalMap: Record<string, number> = {
    excited: 0.9,
    frustrated: 0.8,
    grateful: 0.5,
    curious: 0.6,
    urgent: 0.9,
    disappointed: 0.3,
  }

  for (const [emotion, keywords] of Object.entries(userEmotions)) {
    if (keywords.some((kw) => userMsg.toLowerCase().includes(kw))) {
      events.push({
        event: `User expressed ${emotion}: ${userMsg.slice(0, 100)}`,
        valence: valenceMap[emotion],
        arousal: arousalMap[emotion],
        mood: emotion,
      })
    }
  }

  // Success/failure emotions — stable event text hashes to a stable memory id,
  // so this replaces rather than accumulates (legacy behavior).
  if (success) {
    events.push({ event: "Task completed successfully", valence: 0.6, arousal: 0.4, mood: "accomplished" })
  } else {
    events.push({ event: "Task failed or incomplete", valence: -0.4, arousal: 0.6, mood: "determined" })
  }

  return events
}

// ---------------------------------------------------------------------------
// Conversation compression
// ---------------------------------------------------------------------------

function compressConversation(input: {
  sessionID: string
  userText: string
  response: string
  tools: string[]
  messageCount: number
}): { summary: string } | null {
  if (input.messageCount < 3) return null

  const topics = extractTopics(input.userText)
  const toolsUsed = [...new Set(input.tools)]

  const summaryParts: string[] = []
  if (topics.length > 0) summaryParts.push(`Topic: ${topics.slice(0, 3).join(", ")}`)
  if (toolsUsed.length > 0) summaryParts.push(`Tools: ${toolsUsed.slice(0, 5).join(", ")}`)
  const summary = summaryParts.length > 0 ? summaryParts.join("; ") : `Chat about: ${input.userText.slice(0, 50)}`

  const convData = {
    session_id: input.sessionID,
    timestamp: new Date().toISOString(),
    summary,
    topics,
    tools_used: toolsUsed,
    message_count: input.messageCount,
    user_message_preview: input.userText.slice(0, 200),
    response_preview: input.response.slice(0, 200),
  }

  fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true })
  try {
    fs.writeFileSync(path.join(CONVERSATIONS_DIR, `${input.sessionID.slice(0, 16)}.json`), JSON.stringify(convData, null, 2))
  } catch {
    // Compression is best-effort — the summary memory below still lands.
  }

  return { summary }
}

function extractTopics(text: string): string[] {
  const topics: string[] = []
  const topicPatterns = [
    /(?:about|regarding|concerning|on)\s+(.+?)(?:\.|,|\?|$)/gi,
    /(?:help|assist|fix|solve|build|create|implement)\s+(.+?)(?:\.|,|\?|$)/gi,
  ]
  for (const pattern of topicPatterns) {
    for (const match of text.matchAll(pattern)) {
      const topic = match[1].trim().slice(0, 50)
      if (topic.length > 3) topics.push(topic)
    }
  }

  if (topics.length > 0) return topics

  // Fallback: important words
  const commonWords = new Set(["this", "that", "with", "from", "have", "been", "were", "they", "their", "what", "when", "where", "which", "about"])
  return text
    .split(/\s+/)
    .filter((w) => w.length > 4 && !commonWords.has(w.toLowerCase()))
    .slice(0, 3)
}

// ---------------------------------------------------------------------------
// Learning statistics
// ---------------------------------------------------------------------------

interface LearningStats {
  total_skills?: number
  total_knowledge?: number
  total_lessons?: number
  total_conversations?: number
  recent?: { timestamp: string; skills: number; knowledge: number; lessons: number }[]
}

function updateLearningStats(learnings: Learnings): void {
  const stats = JSON.parse(soulGet("learning_stats", "{}")) as LearningStats

  stats.total_skills = (stats.total_skills ?? 0) + learnings.skills_extracted.length
  stats.total_knowledge = (stats.total_knowledge ?? 0) + learnings.knowledge_extracted.length
  stats.total_lessons = (stats.total_lessons ?? 0) + learnings.lessons_learned.length
  stats.total_conversations = (stats.total_conversations ?? 0) + (learnings.conversation_compressed ? 1 : 0)

  const recent = stats.recent ?? []
  recent.push({
    timestamp: new Date().toISOString(),
    skills: learnings.skills_extracted.length,
    knowledge: learnings.knowledge_extracted.length,
    lessons: learnings.lessons_learned.length,
  })
  stats.recent = recent.slice(-20)

  soulSet("learning_stats", JSON.stringify(stats))
}

export function getLearningStats(): {
  total_skills: number
  total_knowledge: number
  total_lessons: number
  total_conversations: number
  recent_activity: unknown[]
} {
  const stats = JSON.parse(soulGet("learning_stats", "{}")) as LearningStats
  return {
    total_skills: stats.total_skills ?? 0,
    total_knowledge: stats.total_knowledge ?? 0,
    total_lessons: stats.total_lessons ?? 0,
    total_conversations: stats.total_conversations ?? 0,
    recent_activity: (stats.recent ?? []).slice(-5),
  }
}
