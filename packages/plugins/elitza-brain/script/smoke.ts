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
    model: "elitza/xiaomi/mimo-v2.6-flash",
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
assert.ok(summary.includes("elitza/xiaomi/mimo-v2.6-flash"), "config summary shows model")
assert.ok(summary.includes("testprov"), "config summary lists providers")
const modelSection = JSON.parse(configSection("model", [])) as { model: string }
assert.equal(modelSection.model, "elitza/xiaomi/mimo-v2.6-flash", "model section lookup")
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
assert.equal(tools.length, 26, "twenty-six brain tools")
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
  "enrich_client",
  "doctor_check",
  "doctor_repair",
  "doctor_history",
  "gapfeed_build_pipeline",
  "gapfeed_query_signals",
  "handover",
  "outreach",
  "playbook",
  "production",
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
  // handover writes a document wherever it is pointed: keep the loop out of
  // the real repository working tree.
  if (tool.name === "handover") args.out = `${home}/handover-loop.md`
  const result = await tool.execute(args)
  assert.ok(typeof result.content === "string" && result.content.length > 0, `${tool.name} returns content`)
}

// --- client scouting: OSM-first waterfall, Places fallback, keys stay home -----
const { scoutKeyPresent } = await import("../src/scouting.js")
let overpassElements: unknown[] = []
let overpassQueries: string[] = []
const overpassServer = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const body = await request.text()
    overpassQueries.push(new URLSearchParams(body).get("data") ?? "")
    return Response.json({ elements: overpassElements })
  },
})
process.env.OVERPASS_URL = `http://127.0.0.1:${overpassServer.port}/api/interpreter`
const photonServer = Bun.serve({ port: 0, fetch: () => Response.json({ features: [] }) })
process.env.PHOTON_URL = `http://127.0.0.1:${photonServer.port}/api/`
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

// OSM first: enough Overpass hits stop the waterfall before Places is billed.
overpassElements = [
  {
    type: "node",
    lat: 45.29,
    lon: 9.76,
    tags: {
      name: "Studio Dentale Rossi",
      amenity: "dentist",
      "addr:street": "Via Roma",
      "addr:housenumber": "1",
      "addr:postcode": "26022",
      "addr:city": "Castelleone",
      "contact:phone": "+39 0374 123456",
      "contact:website": "https://studio-rossi.example",
    },
  },
  {
    type: "way",
    id: 42,
    center: { lat: 45.3, lon: 9.77 },
    tags: {
      name: "Studio Bianchi",
      amenity: "dentist",
      "addr:full": "Via Garibaldi 4, 26022 Castelleone CR",
    },
  },
]
overpassQueries = []
placesRequest = null
const scoutOsmOnly = await scoutTool!.execute({ location: "Castelleone, Italy", query: "dentist", limit: 2 })
const osmBody = JSON.parse(scoutOsmOnly.content) as {
  count: number
  businesses: { name: string; address: string; phone: string | null; website: string | null; google_maps: string | null }[]
  meta: { sources_used: string[] }
}
assert.equal(osmBody.count, 2, "both OSM businesses returned")
assert.deepEqual(osmBody.meta.sources_used, ["osm"], "OSM listed as the contributing source")
assert.equal(osmBody.businesses[0].phone, "+39 0374 123456", "phone read from contact:phone")
assert.equal(osmBody.businesses[0].website, "https://studio-rossi.example", "website read from contact:website")
assert.equal(osmBody.businesses[1].address, "Via Garibaldi 4, 26022 Castelleone CR", "address read from addr:full")
assert.equal(osmBody.businesses[0].google_maps, null, "no map link invented for OSM rows")
assert.ok(overpassQueries[0].includes('["admin_level"="8"]'), "city areas scoped at admin_level=8")
assert.ok(overpassQueries[0].includes("out center tags"), "ways and relations get center coordinates")
assert.ok(overpassQueries[0].includes('["amenity"="dentist"]'), "query mapped to the OSM tag")
assert.equal(placesRequest, null, "Places not called once OSM returned enough")

// Waterfall: too few OSM hits fall through to Places behind the key.
overpassElements = []
placesRequest = null
const scoutRun = await scoutTool!.execute({ location: "Castelleone, Italy", query: "dentist", limit: 5 })
const scoutBody = JSON.parse(scoutRun.content) as {
  count: number
  businesses: { name: string; phone: string | null; rating: number | null; rating_count: number | null; category: string }[]
  meta: { sources_used: string[] }
}
assert.equal(scoutBody.count, 2, "both places returned")
assert.deepEqual(scoutBody.meta.sources_used, ["google_places"], "Places listed as the contributing source")
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

// Dedup: the same studio in both sources keeps one row and merges the rating.
overpassElements = [
  {
    type: "node",
    lat: 45.29,
    lon: 9.76,
    tags: { name: "Studio Dentale Rossi", amenity: "dentist", phone: "+39 0374 123456" },
  },
]
placesRequest = null
const scoutMerged = await scoutTool!.execute({ location: "Castelleone, Italy", query: "dentist", limit: 5 })
const mergedBody = JSON.parse(scoutMerged.content) as {
  count: number
  businesses: { name: string; rating: number | null; google_maps: string | null }[]
  meta: { sources_used: string[] }
}
assert.equal(mergedBody.count, 2, "phone duplicate merged away")
assert.equal(mergedBody.businesses[0].rating, 4.7, "rating filled in from Places")
assert.equal(mergedBody.businesses[0].google_maps, "https://maps.example/studio-rossi", "map link filled in from Places")
assert.deepEqual(mergedBody.meta.sources_used, ["osm", "google_places"], "both sources credited")

// No key: Google is simply skipped and OSM still answers.
delete process.env.GOOGLE_MAPS_API_KEY
overpassElements = [
  {
    type: "node",
    lat: 45.29,
    lon: 9.76,
    tags: { name: "Studio Dentale Rossi", amenity: "dentist", phone: "+39 0374 123456" },
  },
]
const scoutNoKey = await scoutTool!.execute({ location: "Castelleone, Italy", query: "dentist" })
const noKeyBody = JSON.parse(scoutNoKey.content) as { count: number; meta: { sources_used: string[] } }
assert.equal(noKeyBody.count, 1, "keyless scouting still finds businesses")
assert.deepEqual(noKeyBody.meta.sources_used, ["osm"], "OSM carries the keyless search")
assert.ok(!scoutNoKey.content.includes("GOOGLE_MAPS_API_KEY is not set"), "no key nag when OSM works")
placesServer.stop(true)
overpassServer.stop(true)
photonServer.stop(true)
delete process.env.GOOGLE_PLACES_URL
delete process.env.OVERPASS_URL
delete process.env.PHOTON_URL

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

// --- outreach pipeline: draft, batch approval, Resend send ------------------
const { listPipeline } = await import("../src/outreach.js")
const outreachTool = tools.find((t) => t.name === "outreach")
assert.ok(outreachTool, "outreach registered")
const outreachOp = (operation: Record<string, unknown>) => outreachTool!.execute({ operation })
await crmOp({ action: "update", id: 1, email: "info@rossi.example" })
assert.ok((await outreachOp({ action: "add", client_id: 1 })).content.startsWith("Queued 1:"), "client queued")
const drafted = await outreachOp({
  action: "draft",
  client_id: 1,
  subject: "Faster intake for Studio Rossi",
  body: "Hello — I automate intake for dental studios in Cremona. Worth 15 minutes this week?",
})
assert.ok(drafted.content.includes("Nothing sent"), "draft states nothing was sent")
const draftPath = drafted.content.split("\n")[0].split(": ")[1] ?? ""
assert.ok(fs.existsSync(draftPath), "draft file written")
const draftText = fs.readFileSync(draftPath, "utf8")
assert.ok(draftText.includes('Reply "no"'), "opt-out footer present at review time")
assert.ok(draftText.includes("status: drafted"), "draft starts unapproved")
const noKey = await outreachOp({ action: "send", ids: [1] })
assert.ok(noKey.content.includes("RESEND_API_KEY is not set"), "sending without a key explains the fix")

let resendRequest: { auth: string | null; body: string } | null = null
const resendServer = Bun.serve({
  port: 0,
  fetch: async (request) => {
    resendRequest = { auth: request.headers.get("Authorization"), body: await request.text() }
    return Response.json({ id: "email_smoke" })
  },
})
process.env.RESEND_URL = `http://127.0.0.1:${resendServer.port}`
process.env.RESEND_API_KEY = "re_smoke_key"
process.env.RESEND_FROM = "Dario Cositore <hello@elitza.life>"
const unapproved = await outreachOp({ action: "send", ids: [1] })
assert.ok(unapproved.content.includes("failed 1: not approved"), "unapproved drafts never send")
assert.equal(resendRequest, null, "no Resend call was made before approval")
await outreachOp({ action: "approve", ids: [1] })
const sent = await outreachOp({ action: "send", ids: [1] })
assert.ok(sent.content.startsWith("Sent 1 draft"), "approved draft goes out")
assert.ok(resendRequest?.auth?.includes("re_smoke_key"), "Resend called with the operator's key as a bearer")
const sentBody = JSON.parse(resendRequest!.body) as { from: string; to: string[]; subject: string; text: string }
assert.equal(sentBody.to[0], "info@rossi.example", "recipient comes from the CRM row")
assert.ok(sentBody.text.includes('Reply "no"'), "the sent message keeps the opt-out")
const afterSend = JSON.parse((await crmOp({ action: "get", id: 1 })).content) as {
  status: string
  last_contact: string | null
}
assert.equal(afterSend.status, "contacted", "first send moves the client to contacted")
assert.ok(afterSend.last_contact, "last_contact set by the send")
const pipelineRow = listPipeline()[0]
assert.equal(pipelineRow.touch, 1, "touch count after the first send")
assert.equal(pipelineRow.stage, "contacted", "pipeline stage mirrors the client status")
assert.equal(pipelineRow.approved, 0, "a sent draft can never be re-approved")
const expectedNext = Date.parse(pipelineRow.last_touch_at!) + 3 * 86_400_000
assert.ok(Math.abs(Date.parse(pipelineRow.next_touch_at!) - expectedNext) < 5_000, "next touch due in 3 days")
assert.ok(
  (await crmOp({ action: "interactions", id: 1 })).content.includes("first_touch"),
  "the send is recorded as an interaction",
)
assert.ok(fs.readFileSync(draftPath, "utf8").includes("status: sent"), "draft file marked sent in place")
assert.ok(/sent_at: \d{4}-\d{2}-\d{2}T/.test(fs.readFileSync(draftPath, "utf8")), "sent_at stamped once, as an ISO time")
resendServer.stop(true)
delete process.env.RESEND_URL
delete process.env.RESEND_API_KEY
delete process.env.RESEND_FROM

// --- cadence scheduler: due rows draft once, then the next interval ----------
assert.ok((await outreachOp({ action: "due" })).content.includes("No follow-up is due"), "cadence idle before day +3")
const crmConn = new Database(`${home}/brain/crm.db`)
crmConn.run("UPDATE pipeline SET next_touch_at = ? WHERE id = ?", [
  new Date(Date.now() - 3_600_000).toISOString(),
  1,
])
crmConn.close()
assert.ok((await outreachOp({ action: "due" })).content.includes("touch=1/4"), "due once day +3 passes")
const queued = await outreachOp({ action: "queue" })
assert.ok(queued.content.startsWith("Drafted 1 follow-up"), "due follow-up drafted by the scheduler")
const followupPath = queued.content.split("\n")[1]?.replace(/^- /, "").split(" ")[0] ?? ""
assert.ok(fs.existsSync(followupPath), "follow-up file written")
const followupText = fs.readFileSync(followupPath, "utf8")
assert.ok(followupText.includes("subject: Re: Faster intake for Studio Rossi"), "follow-up stays in the sent thread")
assert.ok(followupText.includes("touch: 2"), "second touch drafted")
assert.ok(followupText.includes("status: drafted"), "follow-up waits for review, not sending")
assert.ok(
  (await outreachOp({ action: "queue" })).content.includes("Nothing due"),
  "the same follow-up is never drafted twice",
)

const resendServer2 = Bun.serve({
  port: 0,
  fetch: async (request) => {
    await request.text()
    return Response.json({ id: "email_smoke_followup" })
  },
})
process.env.RESEND_URL = `http://127.0.0.1:${resendServer2.port}`
process.env.RESEND_API_KEY = "re_smoke_key"
process.env.RESEND_FROM = "Dario Cositore <hello@elitza.life>"
await outreachOp({ action: "approve", ids: [1] })
await outreachOp({ action: "send", ids: [1] })
const afterFollowup = listPipeline()[0]
assert.equal(afterFollowup.touch, 2, "second touch counted")
assert.equal(afterFollowup.stage, "followup_1", "stage advanced to followup_1")
assert.equal(afterFollowup.queued_touch, 0, "sent draft no longer queued")
const expectedSecond = Date.parse(afterFollowup.last_touch_at!) + 7 * 86_400_000
assert.ok(Math.abs(Date.parse(afterFollowup.next_touch_at!) - expectedSecond) < 5_000, "third touch due in 7 days")
resendServer2.stop(true)
delete process.env.RESEND_URL
delete process.env.RESEND_API_KEY
delete process.env.RESEND_FROM

// --- disposition: verdicts stop the cadence and route the client -------------
await crmOp({ action: "add", name: "Pizzeria Bianca", vertical: "food", status: "scouted" })
await outreachOp({ action: "add", client_id: 2 })
const saidYes = await outreachOp({ action: "dispose", id: 2, verdict: "yes", note: "asked for a pilot" })
assert.ok(saidYes.content.includes("client 2 → diagnose"), "yes moves the client into production")
const yesClient = JSON.parse((await crmOp({ action: "get", id: 2 })).content) as { status: string }
assert.equal(yesClient.status, "diagnose", "production starts at diagnose")
const yesRow = listPipeline().find((r) => r.id === 2)!
assert.equal(yesRow.stage, "yes", "the verdict is kept on the pipeline row")
assert.equal(yesRow.next_touch_at, null, "no verdict ever leaves a follow-up scheduled")
assert.equal(yesRow.approved, 0, "no verdict ever leaves a draft approved")
await outreachOp({ action: "dispose", id: 1, verdict: "no", note: "not now" })
const noClient = JSON.parse((await crmOp({ action: "get", id: 1 })).content) as { status: string }
assert.equal(noClient.status, "stale", "a no moves the client to the stale list")
assert.ok(
  (await crmOp({ action: "search", status: "stale" })).content.includes("Studio Rossi"),
  "the stale list is queryable for nurture",
)
const badVerdict = await outreachOp({ action: "dispose", id: 1, verdict: "maybe" })
assert.ok(badVerdict.content.includes("Unknown verdict"), "unknown verdict refused")

await crmOp({ action: "add", name: "Studio Verdi", status: "scouted" })
await crmOp({ action: "update", id: 3, email: "verdi@example.test" })
await outreachOp({ action: "add", client_id: 3 })
const sweepConn = new Database(`${home}/brain/crm.db`)
sweepConn.run("UPDATE pipeline SET touch = 4, stage = 'followup_3', next_touch_at = NULL WHERE id = 3")
sweepConn.run("UPDATE clients SET status = 'followup_3' WHERE id = 3")
sweepConn.close()
const swept = await outreachOp({ action: "sweep" })
assert.ok(swept.content.includes("Moved 1 client"), "four silent touches close the cadence")
const silentRow = listPipeline().find((r) => r.id === 3)!
assert.equal(silentRow.stage, "stale", "exhausted row marked stale")
const silentClient = JSON.parse((await crmOp({ action: "get", id: 3 })).content) as { status: string }
assert.equal(silentClient.status, "stale", "exhausted client moved to the stale list")
assert.ok(
  (await crmOp({ action: "interactions", id: 3 })).content.includes("cadence_exhausted"),
  "the silent end is recorded as an interaction",
)
assert.ok((await outreachOp({ action: "sweep" })).content.includes("No silent cadence"), "sweep is idempotent")

// --- work production pipeline: diagnose -> ... -> done queue -----------------
const prodTool = tools.find((t) => t.name === "production")
assert.ok(prodTool, "production registered")
const prodOp = (operation: Record<string, unknown>) => prodTool!.execute({ operation })
const notWon = await prodOp({ action: "where", id: 3 })
assert.ok(notWon.content.includes("not in production"), "a stale client stays out of production")
const prodWhere = await prodOp({ action: "where", id: 2 })
assert.ok(prodWhere.content.includes("[diagnose]"), "a yes lands at diagnose")
assert.ok(prodWhere.content.includes("Gather the facts"), "the stage supplies the next action")
const advanced = await prodOp({
  action: "advance",
  id: 2,
  stage: "proposal",
  note: "scope confirmed on email",
  asset_kind: "proposal",
  asset_name: "Draft proposal",
  asset_path: "/tmp/proposal-pizzeria.md",
})
assert.ok(advanced.content.includes("diagnose → proposal"), "stage move reported")
assert.ok((await crmOp({ action: "assets", id: 2 })).content.includes("Draft proposal"), "proposal artifact attached")
assert.ok(
  (await prodOp({ action: "advance", id: 2, stage: "proposal" })).content.includes("proposal → proposal"),
  "re-advancing the same stage is idempotent",
)
assert.ok(
  (await prodOp({ action: "advance", id: 2, stage: "banana" })).content.includes("Unknown production stage"),
  "unknown stage refused",
)
await prodOp({ action: "schedule_call", id: 2, when: "2026-11-03T10:00:00Z", note: "kickoff" })
const afterCall = JSON.parse((await crmOp({ action: "get", id: 2 })).content) as {
  status: string
  next_action_at: string | null
}
assert.equal(afterCall.status, "scheduled", "booking the call moves the case to scheduled")
assert.equal(afterCall.next_action_at, "2026-11-03T10:00:00Z", "the call lands as a dated next action")
const paid = await prodOp({ action: "record_payment", id: 2, amount: 1800, invoice_path: "/tmp/invoice-pizzeria.md" })
assert.ok(paid.content.includes("€1800"), "payment amount reported")
const afterPay = JSON.parse((await crmOp({ action: "get", id: 2 })).content) as {
  status: string
  deal_value: number | null
}
assert.equal(afterPay.status, "payment", "money moves the case to payment")
assert.equal(afterPay.deal_value, 1800, "deal value recorded")
assert.ok(
  (await prodOp({ action: "advance", id: 2, stage: "done", note: "delivered" })).content.includes("payment → done"),
  "delivery closes the case",
)
assert.ok(
  (await crmOp({ action: "search", status: "done" })).content.includes("Pizzeria Bianca"),
  "the done queue is queryable",
)
assert.ok(
  (await prodOp({ action: "record_payment", id: 2, amount: 100 })).content.includes("already in the done queue"),
  "a closed case refuses new work steps",
)

// --- knowledge base: curated playbooks seed once, operator edits win --------
const { ensureKnowledge, readPlaybook } = await import("../src/knowledge.js")
const { listProceduralSkills } = await import("../src/memory.js")
assert.equal(ensureKnowledge().length, 6, "six curated playbooks seeded on first run")
assert.ok(
  fs.existsSync(`${home}/brain/procedural/ai-enablement-diagnosis.md`),
  "playbook lands in the procedural folder",
)
assert.equal(ensureKnowledge().length, 0, "a second seed never overwrites")
fs.appendFileSync(`${home}/brain/procedural/payment-terms.md`, "\nOperator edit.\n")
ensureKnowledge()
assert.ok(readPlaybook("payment-terms")?.includes("Operator edit"), "operator edits survive reseeding")
assert.equal(readPlaybook("../../soul"), null, "playbook names cannot leave the folder")
const parsed = listProceduralSkills().find((skill) => skill.name === "workbook-library")
assert.ok(parsed?.description.includes("workbook"), "the existing procedural parser reads the description line")

const playbookTool = tools.find((t) => t.name === "playbook")
assert.ok(playbookTool, "playbook registered")
const playbookList = await playbookTool!.execute({ operation: { action: "list" } })
assert.ok(playbookList.content.includes("discovery-call-script"), "playbook list shows the library")
const playbookRead = await playbookTool!.execute({
  operation: { action: "read", name: "fixed-scope-proposal" },
})
assert.ok(playbookRead.content.includes("EUR 2,500"), "playbook read returns the template text")
assert.ok(
  (await playbookTool!.execute({ operation: { action: "read", name: "nope" } })).content.includes(
    "No playbook named",
  ),
  "unknown playbook explained",
)

// --- handover generator: evidence-driven, names never values ----------------
const handoverTool = tools.find((t) => t.name === "handover")
assert.ok(handoverTool, "handover registered")
const handoverPath = `${home}/CLIENT_SOP_HANDOVER.md`
const handoverRun = await handoverTool!.execute({ out: handoverPath, client_id: 2 })
assert.ok(handoverRun.content.includes(handoverPath), "generator reports where it wrote")
assert.ok(fs.existsSync(handoverPath), "handover document written")
const handoverText = fs.readFileSync(handoverPath, "utf8")
for (const heading of [
  "## Architecture",
  "## Environment and secrets",
  "## Daily operation",
  "## Maintenance",
  "## Edge cases and recovery",
  "## Approval gates",
  "## Support and ownership",
]) {
  assert.ok(handoverText.includes(heading), `section present: ${heading}`)
}
assert.ok(handoverText.includes("RESEND_API_KEY"), "env scan finds real variable names in tracked source")
assert.ok(!/RESEND_API_KEY=/.test(handoverText), "no value is ever written next to a name")
assert.ok(!handoverText.includes("re_smoke_key"), "no test secret leaks into the document")
assert.ok(/- [0-9a-f]{7} \d{4}-\d{2}-\d{2} /m.test(handoverText), "git history is quoted as evidence")
assert.ok(handoverText.includes("CRM client 2"), "the CRM client is named")
const missingRepo = await handoverTool!.execute({ repo: "/nonexistent-folder-xyz", out: `${home}/nope.md` })
assert.ok(missingRepo.content.includes("Handover error"), "a missing folder is explained, not thrown")

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

// --- visual wizard: scripted dialog run, key ping, hand-off, adoption -----
const { runWizard, verifyMiMo } = await import("../src/wizard.js")
type WizardModule = typeof import("../src/wizard.js")
type WizardIO = Parameters<WizardModule["runWizard"]>[0]

const wizardReplies = new Map<string, () => unknown>()
const wizardAsked: string[] = []
const answerFor = (title: string): unknown => {
  wizardAsked.push(title)
  for (const [fragment, reply] of wizardReplies) {
    if (title.includes(fragment)) {
      wizardReplies.delete(fragment)
      return reply()
    }
  }
  throw new Error(`wizard asked an unexpected question: ${title}`)
}
const fakeIO: WizardIO = {
  dialog: {
    show() {},
    set() {},
    clear() {},
    async alert() {},
    async confirm() {
      return true
    },
    async prompt(options) {
      return answerFor(options.title) as string | undefined
    },
    async select(options) {
      return answerFor(options.title) as never
    },
  },
  toast: { show() {} },
}
const savedProgress: Array<{ step: number; postponed?: boolean; answers: Record<string, string> }> = []
const saveProgress = async (next: { step: number; postponed?: boolean; answers: Record<string, string> }) => {
  savedProgress.push(next)
}

const verifyServer = Bun.serve({
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === "/bad") return new Response("invalid key", { status: 401 })
    return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  },
})
process.env.ELITZA_MIMO_VERIFY_URL = `http://127.0.0.1:${verifyServer.port}/ok`

// Postponing at the welcome screen saves no answers and writes no hand-off.
wizardReplies.set("Do you already have your MiMo account", () => undefined)
const postponed = await runWizard(fakeIO, { step: 0, answers: {} }, saveProgress)
assert.equal(postponed, "postponed", "welcome esc postpones the wizard")
assert.equal(savedProgress.at(-1)?.postponed, true, "postponement is persisted")
assert.ok(!fs.existsSync(onboarding.WIZARD_FILE), "no hand-off file when postponed")

// A full scripted run: key verified against the local mock, skips map to
// fallbacks, secrets never reach the hand-off file.
wizardReplies.clear()
wizardReplies.set("Do you already have your MiMo account", () => "yes")
wizardReplies.set("Which MiMo endpoint", () => "standard")
wizardReplies.set("Paste your MiMo API key", () => "smoke-wizard-key-raw")
wizardReplies.set("What should I be called", () => "Zara")
wizardReplies.set("What should I call you", () => "Kai")
wizardReplies.set("What am I to you", () => "a co-pilot")
wizardReplies.set("How should I talk to you", () => "blunt")
wizardReplies.set("Do I ask before I act", () => "ask first")
wizardReplies.set("What must I absolutely never do", () => "skip")
wizardReplies.set("What should I check with you", () => "before running commands")
wizardReplies.set("What should I remember", () => "keep decisions, never passwords")
wizardReplies.set("Anything else", () => "")
wizardReplies.set("And your Maton gateway key", () => undefined)
const handoff = await runWizard(fakeIO, { step: 0, answers: {} }, saveProgress)
assert.equal(handoff, "handed-off", "full run hands off")
assert.ok(wizardAsked.some((title) => title.includes("Paste your MiMo API key")), "the key step ran")
assert.equal(savedProgress.at(-1)?.step, 0, "progress clears after hand-off")

const payload = JSON.parse(fs.readFileSync(onboarding.WIZARD_FILE, "utf8")) as {
  started?: string
  answers: Record<string, string>
}
assert.equal(payload.answers.name, "Zara", "persona answers reach the hand-off")
assert.equal(payload.answers.mimo_key, onboarding.SECRET_SAVED, "key is a placeholder in the hand-off")
assert.equal(
  payload.answers.never,
  "nothing in particular, but I will never do anything that destroys your work or sends anything without saying so",
  "skip stores the question's default",
)
assert.equal(payload.answers.maton_key, "not now", "skipped Maton key keeps its default")
assert.ok(!JSON.stringify(payload.answers).includes("smoke-wizard-key-raw"), "raw key never enters the hand-off")
assert.ok(
  fs.readFileSync(`${home}/.env`, "utf8").includes("XIAOMI_API_KEY=smoke-wizard-key-raw"),
  "the wizard wrote the key to its 600 file",
)

// Adoption lands in the soul exactly like the interview's own finish.
const adopted = onboarding.adoptAnswers(payload.answers, payload.started)
assert.ok(adopted.completed && !adopted.active, "adoption closes the setup")
const soulRow = onboarding.loadState()
assert.equal(soulRow.answers.name, "Zara", "adopted answers live in the soul")
assert.ok(!JSON.stringify(soulRow).includes("smoke-wizard-key-raw"), "raw key never lands in the soul")

// A raw secret smuggled into adoption is re-routed to its 600 file anyway.
const defended = onboarding.adoptAnswers({ ...payload.answers, mimo_key: "raw-second-key" })
assert.equal(defended.answers.mimo_key, onboarding.SECRET_SAVED, "adoption never stores a raw secret")
assert.ok(
  fs.readFileSync(`${home}/.env`, "utf8").includes("XIAOMI_API_KEY=raw-second-key"),
  "the raw secret was written to the env file instead",
)

// The key check reports honest failures, not throws.
process.env.ELITZA_MIMO_VERIFY_URL = `http://127.0.0.1:${verifyServer.port}/bad`
const bad = await verifyMiMo("standard", "wrong-key")
assert.equal(bad.ok, false, "a 401 fails the check")
assert.ok(bad.reason?.includes("401"), "the reason carries the status")

// .env loading feeds the engine process keys entered mid-session.
delete process.env.XIAOMI_API_KEY
delete process.env.SMOKE_LATE_TOKEN
fs.appendFileSync(`${home}/.env`, "SMOKE_LATE_TOKEN=late-1\n")
const loaded = onboarding.loadEnvFile()
assert.ok(loaded.includes("XIAOMI_API_KEY") && loaded.includes("SMOKE_LATE_TOKEN"), "both keys load")
assert.equal(process.env.XIAOMI_API_KEY, "raw-second-key", "the key reaches the process environment")
assert.equal(onboarding.loadEnvFile().length, 0, "loading is idempotent")

verifyServer.stop()
fs.rmSync(onboarding.WIZARD_FILE, { force: true })

fs.rmSync(home, { recursive: true, force: true })
console.log("BRAIN SMOKE TEST: all assertions passed")
