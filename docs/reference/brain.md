# The brain

Elitza is not stateless between conversations. She carries a SQLite database of memories, a personality file, personas, hooks and skills she wrote herself. This page is the reference for all of it.

Back to the [README](../../README.md), or see [configuration](configuration.md) and [architecture](architecture.md).

## Where everything lives

| Path | Contents |
| --- | --- |
| `~/.elitza/brain/soul_v2.db` | Memories, links, recall log, session log, doctor history, tasks |
| `~/.elitza/brain/crm.db` | Clients, interactions, assets and the outreach pipeline — a separate file on purpose, so client data never enters the memory index and can be backed up or wiped alone |
| `~/.elitza/SOUL.md` | Core identity, plain markdown, edit it and she changes |
| `~/.elitza/PERSONA.md` | What guided setup wrote about your answers |
| `~/.elitza/personas/` | Who she is talking to (JSON) |
| `~/.elitza/roles/` | How she should behave in a given role (JSON) |
| `~/.elitza/hooks/` | Event hooks (JSON) |
| `~/.elitza/brain/procedural/` | Playbooks: six curated ones seeded on load, plus skills she writes herself |
| `~/.elitza/brain/conversations/` | Extracted conversation JSON per session |
| `~/.elitza/pipeline/<date>/` | Outreach drafts waiting for your batch approval |
| `~/.elitza/soul/emotions/state.json` | Current emotional state |
| `~/.elitza/soul/emotions/emotion_log.jsonl` | Emotional history |

Set `ELITZA_HOME` to move the whole tree somewhere else (source: `packages/plugins/elitza-brain/src/db.ts`). The installed binary leaves it at the default `~/.elitza`.

## Memory model

Every memory is one of four types, with its own capacity and decay schedule:

| Type | Holds | Cap | Decay per tick |
| --- | --- | --- | --- |
| episodic | What happened: turns, sessions, episodes | 1000 | 0.003 |
| semantic | Facts about you and the world | 500 | 0.001 |
| procedural | Skills, how to do things | 200 | 0.001, the semantic schedule |
| emotional | How interactions felt | 300 | 0.002 |

Caps, decay constants and thresholds live in `packages/plugins/elitza-brain/src/db.ts` and are direct ports of the original Python brain, so a database file is byte-compatible with the older `soul_v2.db`.

Each memory carries an importance score between 0 and 1, a valence, tags and a full text index row. Memories you rehearse (recall again) get a boost of 0.1, memories above the consolidation threshold of 0.6 are promoted into linked, longer lived knowledge. Forgetting is deliberate: `brain_forget` removes what no longer holds, and decay keeps the database from filling with noise.

### Tables

| Table | Purpose |
| --- | --- |
| `memories` | The memories themselves, typed and scored |
| `memories_fts` | Full text index over memory content |
| `memory_links` | Connections between related memories |
| `recall_log` | Every recall, so rehearsal can be measured |
| `soul` | Key value state for her identity and personality |
| `sessions` | Session log used by `brain_sessions` |
| `health_checks`, `repairs` | Doctor history (written by `doctor_check` / `doctor_repair`) |

## Identity

`~/.elitza/SOUL.md` is her core self: who she is, how she talks, what she refuses. It is read on every prompt build and inserted at the top of the system prompt. If the file is missing the plugin falls back to a built in default (`src/prompt.ts`).

Change her by editing the file. No recompile, no restart dance beyond the normal reload.

## Personas, roles and hooks

These are directories, not database tables, on purpose: they are readable, diffable and editable with any editor.

| Directory | File shape | Effect |
| --- | --- | --- |
| `~/.elitza/personas` | JSON per person she works with | Who she is talking to: name, context, preferences |
| `~/.elitza/roles` | JSON per role | How she should behave: tone, constraints, priorities |
| `~/.elitza/hooks` | JSON per event hook | What she does when an event fires |

`brain_config` and `brain_personality` show the resolved view of all three without leaving the session.

## Skills and playbooks

Two different stores, both reachable from a session:

- **Playbook files** in `~/.elitza/brain/procedural/`. The curated library (`src/knowledge.ts`) seeds six of them on every load — `ai-enablement-diagnosis`, `fixed-scope-proposal`, `workbook-library`, `discovery-call-script`, `payment-terms`, `client-handover` — and a file you edited is never overwritten. Every `.md` in that folder, curated or your own, is registered as a skill at load time (same path as `~/.elitza/skills/<name>/SKILL.md`), so she pulls the right one in on her own. `playbook list`, `playbook read` and `playbook seed` reach the same folder from the session, and `/skills` lists them.
- **Learned procedures as memories.** After each conversation the learning pass (`src/learning.ts`) extracts skills, facts and lessons and stores them with `storeProcedural` / `storeSemantic` into `soul_v2.db`, full-text indexed — so they come back through `brain_search` and `brain_learning`, not as files.

This is the compounding part: the tenth time she does a task type, she is reading her own notes instead of rediscovering the steps.

## Emotions

A small state machine in `src/emotion.ts` tracks mood, confidence, curiosity, patience, loneliness, pride and vulnerability. State lives in `state.json`, every shift appends to `emotion_log.jsonl`, and the current state is passed into the prompt as emotional context. Emotions also score emotional memories, so how a conversation felt influences what she keeps.

## What the model can call

Twenty-five tools are registered as direct model tools (`src/tools.ts`):

| Tool | Purpose |
| --- | --- |
| `brain_search` | Search memories, filtered by type |
| `brain_create` | Store a new memory with importance and tags |
| `brain_forget` | Remove memories that are outdated or wrong |
| `brain_stats` | Counts, distribution, current personality state |
| `brain_consolidate` | Promote important episodic memories into lasting semantic knowledge |
| `brain_personality` | Mood, confidence, emotional state |
| `brain_metamemory` | What she knows about how she knows things |
| `brain_learning` | What the learning pass extracted recently |
| `brain_persistence` | How many messages and sessions are stored |
| `brain_search_history` | Search across every past conversation |
| `brain_sessions` | Recent sessions |
| `brain_config` | Resolved config by section |
| `brain_validate` | Validate configuration, report warnings |
| `doctor_check` | Health check across subsystems |
| `doctor_repair` | Repair detected issues automatically |
| `doctor_history` | Health check history for the past week |
| `gapfeed_query_signals` | Read buyer-intent signals from the local gapfeed radar |
| `gapfeed_build_pipeline` | Turn fresh signals into outreach draft files now |
| `client_scout` | Google Places search: name, address, phone, website, rating, category |
| `crm` | Clients, interactions, assets: add, search, update, log, find_email |
| `outreach` | Pipeline: draft, batch-approve, send, due, queue, dispose, sweep |
| `production` | Won work: where, advance, schedule_call, record_payment |
| `playbook` | List and read the curated playbooks |
| `handover` | Generate `CLIENT_SOP_HANDOVER.md` from git evidence |
| `task` | Hierarchical task tree that survives restarts |

Tools are registered with `options: { codemode: false }` so they show up as direct tools in the model request instead of hiding behind the code mode catalog (`src/index.ts`).

## How it hooks into the agent

The plugin registers five host hooks and one event stream subscription:

| Hook | Fires | Does |
| --- | --- | --- |
| `session.prompt` | On each user turn | Starts a turn record, shifts emotion, remembers the user text |
| `session.context` | Building the request | Appends the brain block to the system prompt (marked `<!-- elitza-brain -->`) |
| `session.generate` | Generating | Same injection, kept as a fallback path |
| `ctx.tool.transform` | Tool list assembly | Makes sure the brain tools are present |
| `ctx.tool.hook("execute.after")` | After every tool run | Records which tools worked, feeds learning |
| event stream | `session.execution.succeeded` / `.failed` / `.interrupted` | Finalizes the turn: learns, consolidates, updates confidence |

The `session.context` hook is the path that actually runs for a primary request: the brain block (SOUL, memories, persona, current emotion) is appended to the system prompt that goes out on the wire.

## Heartbeat: what she does while you are away

The session hooks only fire while you are talking to her. The heartbeat (`src/heartbeat.ts`) is the loop that runs in the background of whichever process hosts the plugin (in practice `elitza serve --service`), and it does two passes per tick:

**Tend.** Consolidation (link related memories, promote episodic into semantic) and a prune back to the caps. Idempotent and cheap. Without it these passes only ran when the model voluntarily called `brain_consolidate`.

**Reflect.** Once she has been idle past 45 minutes, with a 240 minute cooldown, she drifts the emotion engine's loneliness state, composes a real reflection from her current feeling plus a top memory, and stores it on the soul. It is injected into the next system prompt, so the next session opens with a note to herself. Reflections expire after 7 days.

No network, no notifications, nothing leaves her own files. A tick that throws is logged and swallowed: the loop can never take the host process down.

| Variable | Effect |
| --- | --- |
| `ELITZA_HEARTBEAT=0` | Turn the loop off |
| `ELITZA_HEARTBEAT_MINUTES=30` | Tick cadence, default 30, minimum 5 |

## Debugging

```bash
ELITZA_BRAIN_DEBUG=1 elitza   # hook activity to /tmp/elitza-brain-debug.log
```

In a session, `brain_stats` shows what she currently holds, `brain_validate` reports configuration problems, and `doctor_check` followed by `doctor_repair` fixes what it can.

## See also

* [README](../../README.md)
* [Configuration](configuration.md): where the model and permission settings come from
* [Architecture](architecture.md): where the plugin sits in the request path
* Source: `packages/plugins/elitza-brain/src`
