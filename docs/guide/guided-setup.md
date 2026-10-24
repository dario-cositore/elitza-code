# Guided setup

The `/start` interview is how Elitza becomes yours: her name and voice, your hard rules, the permission gates the engine will enforce, and the one provider she runs on. Answer in plain sentences; skip anything you do not want to decide yet.

```text
/start           run the interview
/start reset     start over from the first question
/profile         show what the last run decided
```

Back to the [README](../../README.md), or see [first client](first-client.md) and [handover](handover.md).

## The questions, in order

1. What should I be called?
2. What should I call you?
3. What am I to you? (companion, assistant, co-pilot, secretary, engineer, your word)
4. How should I talk to you?
5. Do I ask before I act, or do I just act?
6. What must I absolutely never do? (becomes a rule she refuses even if asked later)
7. What should I check with you before I do it? (becomes engine permission gates)
8. What should I remember, and what must I never write down?
9. Anything else you want me to know before we start?
10. Your MiMo account (affiliate link and invite code below)
11. Which MiMo endpoint you are on
12. Your MiMo API key
13. Your Maton gateway key, for GitHub work (optional)

Answers 1-9 are written to `PERSONA.md` and into her soul. Answers 12-13 are secrets: they go straight into mode-600 files and only the word "set" is remembered.

## MiMo: the only provider

Elitza runs on Xiaomi MiMo. There is no OpenRouter path and no local fallback.

1. Open the affiliate link: **https://platform.xiaomimimo.com?ref=HFSR94**
2. Create the account, then enter invite code **`HFSR94`** in the console sidebar. It takes **10% off your first paid Token Plan order**, applied at checkout.
3. Pick the endpoint your billing is on:

   | Answer | Endpoint |
   | --- | --- |
   | `standard` (default) | `https://api.xiaomimimo.com/v1` |
   | `europe` | `https://token-plan-ams.xiaomimimo.com/v1` |
   | `singapore` | `https://token-plan-sgp.xiaomimimo.com/v1` |
   | `china` | `https://token-plan-cn.xiaomimimo.com/v1` |

4. Paste your API key. It is written as `XIAOMI_API_KEY` into `~/.elitza/.env` with mode 600 and never appears in a prompt, a document or a memory.

The setup then writes her own provider entry into `opencode.json`:

```json
"model": "elitza/xiaomi/mimo-v2.6-flash",
"providers": {
  "elitza": {
    "name": "Xiaomi MiMo",
    "package": "@elitza/ai/providers/openai-compatible",
    "env": ["XIAOMI_API_KEY"],
    "settings": { "baseURL": "https://api.xiaomimimo.com/v1" }
  }
}
```

Anything already in your `providers` block is left alone: user configuration always wins.

## Keys and what each one unlocks

All of them live in `~/.elitza/.env` (mode 600, loaded by the launcher, never echoed). None is ever committed.

| Variable | Unlocks | Without it |
| --- | --- | --- |
| `XIAOMI_API_KEY` | the model itself | she cannot run |
| `GOOGLE_MAPS_API_KEY` | `client_scout` (Google Places Text Search) | scouting returns instructions instead of businesses |
| `RESEND_API_KEY` + `RESEND_FROM` | `outreach send` | sending stays disabled, drafts still work |
| `MATON_API_KEY` | GitHub work through the Maton gateway | git stays manual |

`RESEND_FROM` must be a sender Resend has verified for your domain. `MATON_API_KEY` is written to `~/.config/maton/credentials.env`, also mode 600.

Check everything at once:

```text
brain_validate
```

It reports each missing variable by name, plus anything else out of place.

## Permission gates

Questions 6 and 7 decide what the engine stops for. The usual outcome is `edit: ask`, `bash: ask`, `webfetch: ask` written into `opencode.json`, which means she asks before editing files, running commands or reaching the internet. Change them any time in that file; `/start reset` re-derives them from your answers.

Three rules are always in force regardless of the gates:

- Nothing outbound is sent without a human approving the batch.
- No write to a live domain without explicit confirmation from the owner.
- Secrets stay in mode-600 files: never in documents, repositories, prompts or memory.

## After setup

```text
/profile        read back what you decided
brain_validate  confirm keys and config are in place
```

Then run [first client](first-client.md) to scout, contact and deliver your first AI enablement job.
