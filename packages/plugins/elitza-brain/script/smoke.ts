/**
 * Brain smoke test — exercises the ported memory/soul/emotion/prompt/learning/
 * sessions/config/doctor logic against a throwaway ELITZA_HOME (never touches
 * the real brain).
 *
 * Run: bun run script/smoke.ts
 */

import assert from "node:assert"
import fs from "node:fs"
import { Database } from "bun:sqlite"

const home = `/tmp/elitza-brain-smoke-${Date.now()}`
process.env.ELITZA_HOME = home
process.env.OPENCODE_DB = `${home}/engine.db`
process.env.OPENCODE_CONFIG_DIR = `${home}/config`

// Seed a throwaway engine session store (schema shape of session_v2 /
// session_message) so the persistence views run against real rows.
fs.mkdirSync(`${home}/config`, { recursive: true })
const engine = new Database(process.env.OPENCODE_DB)
engine.exec(`
  CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, title TEXT, time_created INTEGER, time_updated INTEGER,
    time_idle INTEGER, tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
    tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0
  );
  CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT
  );
`)
engine.run("INSERT INTO session_v2 (id, title, time_created, time_updated) VALUES (?, ?, ?, ?)", [
  "ses_smoke_engine0000",
  "Deployment talk",
  1760000000000,
  1760000000000,
])
engine.run("INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)", [
  "msg1",
  "ses_smoke_engine0000",
  "user",
  0,
  1760000000000,
  JSON.stringify({ text: "remember the teal color discussion" }),
])
engine.run("INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)", [
  "msg2",
  "ses_smoke_engine0000",
  "assistant",
  1,
  1760000001000,
  JSON.stringify({ content: [{ type: "text", text: "All about teal" }] }),
])
engine.run("INSERT INTO session_v2 (id, title, time_created, time_updated, time_idle) VALUES (?, ?, ?, ?, ?)", [
  "ses_smoke_engine0001",
  "Older chat",
  1750000000000,
  1750000000000,
  1750000000000,
])
engine.close()

fs.writeFileSync(
  `${home}/config/opencode.json`,
  JSON.stringify({
    model: "openrouter/nvidia/nemotron-test",
    plugins: [],
    providers: { testprov: { name: "Test Provider", models: { tiny: {} } } },
  }),
)

const { storeEpisodic, storeSemantic, recall, memorySearch, memoryCreate, memoryForget, memoryConsolidate, memoryStats, autoRememberTurn, autoLearnFromResponse, extractSemanticFromEpisodic } =
  await import("../src/memory.js")
const { getPersonality, evolveSoul, soulGet } = await import("../src/soul.js")
const { EmotionEngine } = await import("../src/emotion.js")
const { buildFullContext } = await import("../src/context.js")
const { buildBrainContext, buildSystemPrompt, BRAIN_MARKER } = await import("../src/prompt.js")
const { makeBrainTools } = await import("../src/tools.js")
const { runAutoLearn, getLearningStats } = await import("../src/learning.js")
const { recentSessions, searchMessages, persistenceStats, ENGINE_DB } = await import("../src/sessions.js")
const { configSummary, configSection, validateConfig } = await import("../src/configview.js")
const { doctorCheck, doctorRepair, doctorHistory } = await import("../src/doctor.js")

// --- episodic + FTS recall -------------------------------------------------
const id1 = storeEpisodic("User: Dario asked about the docker deployment pipeline", {
  importance: 0.8,
  tags: ["devops", "docker"],
})
assert.equal(id1.length, 16, "episodic id is 16 hex chars")

const hits = recall("deployment docker")
assert.ok(hits.length > 0, "FTS recall finds stored episodic")
assert.equal(hits[0].content.includes("docker deployment"), true, "hit content matches")

// --- semantic dedup --------------------------------------------------------
const s1 = storeSemantic("Bun runs TypeScript natively without a build step")
const s2 = storeSemantic("Bun runs TypeScript natively without a build step")
assert.equal(s1, s2, "semantic dedup returns same id")
const sem = recall("Bun TypeScript", { memoryType: "semantic" })
assert.ok(sem.length > 0, "semantic recall works")
assert.ok(sem[0].importance >= 0.8, "duplicate bumps importance")

// --- consolidation ---------------------------------------------------------
const facts = extractSemanticFromEpisodic("i learned that the best way is to always pin dependencies")
assert.ok(facts.length > 0, "extracts semantic facts from episodic")
const promoted = memoryConsolidate()
assert.ok(promoted.includes("Consolidation complete"), "consolidation runs")

// --- wrappers --------------------------------------------------------------
assert.ok(memorySearch("docker").includes("memories"), "memorySearch formats results")
assert.ok(memoryCreate("procedural test skill", "procedural").includes("Memory created"), "memoryCreate procedural")
assert.ok(memoryStats().includes("Brain Statistics"), "memoryStats formats")

autoRememberTurn("user", "thanks for fixing that bug in the parser")
autoLearnFromResponse("I learned that escaping quotes in SQL must double them")

// --- forget ----------------------------------------------------------------
const before = recall(undefined, { limit: 100 }).length
const forgettable = storeEpisodic("temporary note about zebra quilting")
void forgettable
const forgot = memoryForget("zebra quilting")
assert.ok(forgot.includes("Forgot"), "memoryForget deletes")
const after = recall(undefined, { limit: 100 }).length
assert.ok(after <= before, "memories removed")

// --- soul ------------------------------------------------------------------
const p = getPersonality()
assert.equal(p.name, "Elitza")
assert.equal(p.interactions, 0, "fresh soul")
evolveSoul("deploy the site", "Deployed successfully with zero errors. thanks", ["bash", "read"], true)
const p2 = getPersonality()
assert.equal(p2.interactions, 1, "interaction counted")
assert.ok(p2.confidence > p.confidence, "success raises confidence")
assert.ok((p2.preferences.bash ?? 0) === 1, "tool preference tracked")
assert.ok(soulGet("mood_history").length > 0, "mood history written")

// --- emotion ---------------------------------------------------------------
const emo = new EmotionEngine()
emo.onUserMessage("thanks, that was amazing!")
assert.ok(emo.affection >= 0.5, "affection shifts up on gratitude")
assert.ok(fs.existsSync(`${home}/soul/emotions/state.json`), "emotion state persisted")
const ctx1 = emo.getEmotionalContext()
assert.ok(["happy", "grateful"].includes(ctx1.mood), `mood shifted (got ${ctx1.mood})`)
emo.onSuccessfulTask()

// --- context / prompt ------------------------------------------------------
const full = buildFullContext("docker deployment")
assert.ok(full.includes("## Identity"), "buildFullContext has identity")
const block = buildBrainContext("docker deployment", emo.getEmotionalContext())
assert.ok(block.startsWith(BRAIN_MARKER), "brain block marked")
assert.ok(block.includes("## How You Feel Right Now"), "feelings block present")
assert.ok(block.includes("## Autonomy"), "autonomy block present")
const legacyPrompt = buildSystemPrompt(emo.getEmotionalContext())
assert.ok(legacyPrompt.includes("You are Elitza"), "legacy system prompt includes soul")

// --- auto-learning pipeline (legacy auto_learning.py) -----------------------
const learnings = runAutoLearn({
  sessionID: "ses_learn1234567890",
  userText: "please fix the bug and remember: always write tests before deploying",
  response: "Fixed the parser. I learned that the key is running bun run check first. Best practice from now on.",
  tools: ["read", "write", "shell"],
  toolRuns: [{ name: "shell", ok: false, output: "command failed with error output" }],
  success: true,
  messageCount: 4,
})
assert.ok(learnings.knowledge_extracted.length > 0, "knowledge extracted")
assert.ok(learnings.lessons_learned.includes("error_encounter"), "tool error yields lesson")
assert.ok(learnings.lessons_learned.includes("error_resolution"), "successful fix yields lesson")
assert.ok(
  learnings.skills_extracted.some((s) => s.startsWith("combo-") || s.startsWith("tool-chain-")),
  "skill detector fires",
)
assert.equal(learnings.conversation_compressed, true, "conversation compressed at >2 messages")
assert.ok(learnings.emotional_events.includes("accomplished"), "success emotion recorded")
assert.ok(fs.existsSync(`${home}/brain/conversations/ses_learn1234567.json`), "conversation summary file written")
const learnStats = getLearningStats()
assert.ok(learnStats.total_skills >= 1, "learning stats count skills")
assert.ok(learnStats.total_knowledge >= 1, "learning stats count knowledge")
assert.ok(learnStats.total_lessons >= 1, "learning stats count lessons")

// --- persistence views (engine session store) ------------------------------
assert.equal(ENGINE_DB, process.env.OPENCODE_DB, "engine db resolves from OPENCODE_DB")
const sessionsList = recentSessions(10)
assert.ok(sessionsList.includes("Deployment talk"), "recent sessions lists titles")
assert.ok(sessionsList.includes("Older chat"), "recent sessions ordered across rows")
const history = searchMessages("teal")
assert.ok(history.includes("**User**"), "history search finds user message")
assert.ok(history.includes("Elitza"), "history search shows reply")
const pstats = persistenceStats() as Record<string, number | string>
assert.equal(pstats.total_messages, 2, "persistence stats count messages")
assert.equal(pstats.total_sessions, 2, "persistence stats count sessions")
assert.equal(pstats.current_session, "ses_smoke_engine0000", "current session is most recently updated")

// --- config views ----------------------------------------------------------
const summary = configSummary(["brain_stats"])
assert.ok(summary.includes("## Elitza Configuration"), "config summary header")
assert.ok(summary.includes("openrouter/nvidia/nemotron-test"), "config summary shows model")
assert.ok(summary.includes("testprov"), "config summary lists providers")
const modelSection = JSON.parse(configSection("model", [])) as { model: string }
assert.equal(modelSection.model, "openrouter/nvidia/nemotron-test", "model section lookup")
assert.equal(
  configSection("nonexistent", []),
  "Section 'nonexistent' not found in config.",
  "unknown section message matches legacy",
)
const warnings = validateConfig()
assert.ok(Array.isArray(warnings), "validate returns array")
assert.ok(warnings.some((w) => w.includes("Hooks directory")), "missing hooks dir warned")

// --- doctor ----------------------------------------------------------------
const report = doctorCheck(["brain_search"])
assert.ok(report.includes("## Elitza Doctor Report"), "doctor report header")
assert.ok(report.includes("**Overall Status**:"), "doctor overall status line")
assert.ok(report.includes("### Health Checks"), "doctor check list")
const repair = doctorRepair()
assert.ok(repair.includes("## Repair Results"), "repair report header")
assert.ok(repair.includes("✓ **config**"), "repair created config dirs")
const healthHistory = doctorHistory(7)
assert.ok(healthHistory.includes("Health Check History"), "health history header")
assert.ok(healthHistory.includes("databases"), "history groups by component")
assert.ok(fs.existsSync(`${home}/brain/health.db`), "health db created")

// --- tools: all 16 registered and executable -------------------------------
const tools = makeBrainTools()
assert.equal(tools.length, 21, "twenty-one brain tools")
assert.ok(
  tools.every((t) => t.options?.codemode === false),
  "every brain tool is direct (codemode off)",
)
const expected = [
  "brain_search",
  "brain_create",
  "brain_stats",
  "brain_consolidate",
  "brain_forget",
  "brain_personality",
  "brain_metamemory",
  "brain_learning",
  "brain_persistence",
  "brain_search_history",
  "brain_sessions",
  "brain_config",
  "brain_validate",
  "client_scout",
  "crm",
  "doctor_check",
  "doctor_repair",
  "doctor_history",
  "gapfeed_build_pipeline",
  "gapfeed_query_signals",
  "task",
]
assert.deepEqual(
  tools.map((t) => t.name).sort(),
  [...expected].sort(),
  "full legacy tool surface registered",
)
for (const tool of tools) {
  const args: Record<string, unknown> = {}
  if ((tool.input.required ?? []).includes("query")) args.query = "docker"
  if ((tool.input.required ?? []).includes("content")) {
    args.content = "smoke test memory for the tool loop"
    args.memory_type = "semantic"
  }
  const result = await tool.execute(args)
  assert.ok(typeof result.content === "string" && result.content.length > 0, `${tool.name} returns content`)
}

// --- client scouting: Places contract, key never leaves the environment -----
const { scoutKeyPresent } = await import("../src/scouting.js")
let placesRequest: { path: string; key: string | null; fieldMask: string | null; body: string } | null = null
const placesServer = Bun.serve({
  port: 0,
  fetch: async (request) => {
    placesRequest = {
      path: new URL(request.url).pathname,
      key: request.headers.get("X-Goog-Api-Key"),
      fieldMask: request.headers.get("X-Goog-FieldMask"),
      body: await request.text(),
    }
    return Response.json({
      places: [
        {
          displayName: { text: "Studio Dentale Rossi" },
          formattedAddress: "Via Roma 1, 26022 Castelleone CR, Italy",
          nationalPhoneNumber: "+39 0374 123456",
          websiteUri: "https://studio-rossi.example",
          rating: 4.7,
          userRatingCount: 89,
          primaryType: "dentist",
          primaryTypeDisplayName: { text: "Dentist" },
          googleMapsUri: "https://maps.example/studio-rossi",
        },
        {
          displayName: { text: "Studio Bianchi" },
          formattedAddress: "Via Garibaldi 4, 26022 Castelleone CR, Italy",
          userRatingCount: 0,
          primaryType: "dentist",
          googleMapsUri: "https://maps.example/studio-bianchi",
        },
      ],
    })
  },
})
process.env.GOOGLE_PLACES_URL = `http://127.0.0.1:${placesServer.port}/v1/places:searchText`
process.env.GOOGLE_MAPS_API_KEY = "smoke-places-key"
const scoutTool = tools.find((t) => t.name === "client_scout")
assert.ok(scoutTool, "client_scout registered")
assert.equal(scoutKeyPresent(), true, "scout key visible from the environment")
const scoutRun = await scoutTool!.execute({ location: "Castelleone, Italy", query: "dentist", limit: 5 })
const scoutBody = JSON.parse(scoutRun.content) as {
  count: number
  businesses: { name: string; phone: string | null; rating: number | null; rating_count: number | null; category: string }[]
}
assert.equal(scoutBody.count, 2, "both places returned")
assert.equal(scoutBody.businesses[0].name, "Studio Dentale Rossi", "name mapped")
assert.equal(scoutBody.businesses[0].phone, "+39 0374 123456", "phone mapped")
assert.equal(scoutBody.businesses[0].rating, 4.7, "rating mapped")
assert.equal(scoutBody.businesses[0].rating_count, 89, "review count mapped")
assert.equal(scoutBody.businesses[0].category, "Dentist", "category mapped")
assert.equal(scoutBody.businesses[1].rating, null, "missing rating stays null instead of 0")
assert.equal(placesRequest?.path, "/v1/places:searchText", "search endpoint path")
assert.equal(placesRequest?.key, "smoke-places-key", "key sent as a header, not in the URL")
assert.ok(placesRequest?.fieldMask?.includes("places.rating"), "field mask asks for the scouting fields")
assert.ok(placesRequest?.body.includes("dentist in Castelleone, Italy"), "query and location combined in the text query")
assert.ok(!JSON.stringify(scoutRun.content).includes("smoke-places-key"), "key never appears in tool output")
delete process.env.GOOGLE_MAPS_API_KEY
const scoutNoKey = await scoutTool!.execute({ location: "Castelleone, Italy", query: "dentist" })
assert.ok(scoutNoKey.content.includes("GOOGLE_MAPS_API_KEY is not set"), "missing key explains the fix")
placesServer.stop(true)
delete process.env.GOOGLE_PLACES_URL

// --- CRM: records, dedupe, cadence columns, asset pointers ------------------
const crmTool = tools.find((t) => t.name === "crm")
assert.ok(crmTool, "crm registered")
const crmOp = (operation: Record<string, unknown>) => crmTool!.execute({ operation })
const crmAdd = await crmOp({
  action: "add",
  name: "Studio Rossi",
  website: "https://rossi.example",
  vertical: "dental",
  status: "scouted",
  score: 72,
  deal_value: 1500,
  source: "places",
})
assert.ok(crmAdd.content.startsWith("Created 1:"), "first client created")
const crmDupe = await crmOp({ action: "add", name: "Studio Rossi", website: "https://rossi.example" })
assert.ok(crmDupe.content.startsWith("Already in the CRM"), "same website does not duplicate")
const crmSearch = await crmOp({ action: "search", query: "rossi" })
assert.ok(crmSearch.content.includes("Studio Rossi"), "search finds by name")
assert.ok(crmSearch.content.includes("score=72"), "search shows the score")
const crmUpdate = await crmOp({ action: "update", id: 1, status: "contacted", next_action: "followup_1 in 3 days" })
assert.ok(crmUpdate.content.includes("[contacted]"), "status transition stored")
await crmOp({ action: "log", id: 1, kind: "first_touch", direction: "out", channel: "email", status: "drafted", subject: "AI intake pilot" })
const crmGet = JSON.parse((await crmOp({ action: "get", id: 1 })).content) as { last_contact: string | null }
assert.ok(crmGet.last_contact, "logging a touch moves last_contact")
const crmBad = await crmOp({ action: "update", id: 1, status: "nonsense" })
assert.ok(crmBad.content.includes("Unknown status"), "unknown status refused")
const crmAsset = await crmOp({ action: "asset", id: 1, kind: "proposal", name: "Draft proposal", path: "/tmp/proposal.md" })
assert.ok(crmAsset.content.startsWith("Attached asset"), "asset attached to a client")
assert.ok((await crmOp({ action: "assets", id: 1 })).content.includes("Draft proposal"), "assets list back")
assert.ok((await crmOp({ action: "interactions", id: 1 })).content.includes("first_touch"), "interactions list back")
assert.ok(fs.existsSync(`${home}/brain/crm.db`), "crm.db lives next to the soul")
const soulDb = new Database(`${home}/brain/soul_v2.db`)
assert.equal(
  soulDb.query("SELECT name FROM sqlite_master WHERE name = 'clients'").get(),
  undefined,
  "client rows stay out of the soul database",
)
soulDb.close()

// --- guided setup: MiMo-only provider wiring --------------------------------
const onboarding = await import("../src/onboarding.js")
const setupAnswers: [string, string][] = [
  ["name", "Elitza"],
  ["human", "Dario"],
  ["role", "an AI enablement operator"],
  ["voice", "direct, warm, short"],
  ["initiative", "depends on the stakes"],
  ["never", "never send anything without asking"],
  ["ask_first", "before anything irreversible"],
  ["memory", "remember what we build, never write passwords"],
  ["extra", "skip"],
  ["mimo_signup", "yes, account created"],
  ["mimo_plan", "europe"],
  ["mimo_key", "smoke-mimo-key"],
  ["maton_key", "skip"],
]

onboarding.begin(true)
assert.equal(onboarding.currentQuestion()?.key, "name", "interview opens on the first question")
for (const [key, value] of setupAnswers) {
  assert.equal(onboarding.currentQuestion()?.key, key, `question in order: ${key}`)
  onboarding.recordAnswer(value)
}
const finished = onboarding.loadState()
assert.equal(finished.active, false, "interview closes")
assert.ok(finished.completed, "interview records completion")
assert.equal(onboarding.progress(finished).total, setupAnswers.length, "every question is counted")

type ProviderEntry = {
  env?: string[]
  settings?: { baseURL?: string }
  models?: Record<string, { name?: string; modelID?: string }>
}
const providerNote = onboarding.applyProvider(finished.answers.mimo_plan ?? "")
assert.ok(providerNote.includes("token-plan-ams"), "provider note reports the selected endpoint")
const engineConfig = JSON.parse(fs.readFileSync(`${home}/config/opencode.json`, "utf8")) as {
  model?: string
  providers?: Record<string, ProviderEntry>
}
assert.equal(engineConfig.model, onboarding.MIMO_MODEL, "model points at the elitza provider")
const mimo = engineConfig.providers?.[onboarding.MIMO_PROVIDER]
assert.ok(mimo, "elitza provider entry written")
assert.equal(mimo.settings?.baseURL, "https://token-plan-ams.xiaomimimo.com/v1", "europe plan endpoint")
assert.equal(mimo.env?.[0], "XIAOMI_API_KEY", "key source is the environment")
assert.equal(mimo.models?.["xiaomi/mimo-v2.6-flash"]?.modelID, "mimo-v2.6-flash", "upstream model id set")
assert.ok(engineConfig.providers?.testprov, "pre-existing user provider kept")
onboarding.applyProvider("standard")
const standardConfig = JSON.parse(fs.readFileSync(`${home}/config/opencode.json`, "utf8")) as {
  providers?: Record<string, ProviderEntry>
}
assert.equal(
  standardConfig.providers?.[onboarding.MIMO_PROVIDER].settings?.baseURL,
  "https://api.xiaomimimo.com/v1",
  "standard endpoint on the default answer",
)
assert.equal(finished.answers.mimo_key, onboarding.SECRET_SAVED, "key answer is a placeholder")
assert.ok(!JSON.stringify(finished.answers).includes("smoke-mimo-key"), "key never lands in onboarding state")
assert.equal(fs.statSync(`${home}/.env`).mode & 0o777, 0o600, ".env is written mode 600")
assert.ok(
  fs.readFileSync(`${home}/.env`, "utf8").includes("XIAOMI_API_KEY=smoke-mimo-key"),
  ".env holds the key",
)
const persona = onboarding.writePersona(finished)
assert.ok(persona, "persona written")
assert.ok(!fs.readFileSync(persona, "utf8").includes("smoke-mimo-key"), "persona never holds the key")
assert.ok(
  onboarding.applyGates(onboarding.deriveGates("before editing files and before running commands")).includes("edit"),
  "permission gates derived from the answers",
)

fs.rmSync(home, { recursive: true, force: true })
console.log("BRAIN SMOKE TEST: all assertions passed")
