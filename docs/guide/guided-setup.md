# Guided setup

Setup is how Elitza becomes yours: her name and voice, your hard rules, the permission gates the engine will enforce, and the one provider she runs on. Answer in plain sentences; skip anything you do not want to decide yet.

Two doors, the same thirteen questions: the wizard pops up on first boot, `/start` runs the interview inside chat.

```text
(start)          the wizard opens itself while setup is unfinished
/setup           open the wizard again, or start over once it is complete
/start           run the same interview in chat
/start reset     start over from the first question
/profile         show what the last run decided
```

Back to the [README](../../README.md), or see [first client](first-client.md) and [handover](handover.md).

## The first-boot wizard

The first time you start Elitza with setup unfinished, a popup takes over the composer and asks the questions one at a time, numbered `[1/13]`:

1. A welcome card with the MiMo affiliate link and invite code `HFSR94`, and whether you already have an account. Esc here postpones everything: the wizard stops and will not open itself again until you type `/setup`.
2. Which endpoint you are on (Esc uses `standard`).
3. Your API key, masked as you type. It goes straight into `~/.elitza/.env` with mode 600, then the wizard pings the endpoint to confirm it works. A failed ping offers *Try again* or *Continue anyway*; no key offers *Add it now* or *Later*, and she stays quiet until you add one.
4. The nine persona and gate questions from the list below (items 1-9), then the optional Maton gateway key.

The wizard asks the same thirteen questions `/start` asks, only the MiMo block moves first: the key is the thing that makes her reply, so it comes before the persona questions. In chat, `/start` keeps the order below.

Progress is saved after every step, so a restart resumes where you left off. The only network call is a four-token key check against your own key, so nothing else runs a model during setup.

When the last question is answered the wizard writes a hand-off file, says "You're all set", and closes. The engine picks that file up on your first message and applies persona, hard rules, permission gates, provider and keys in one go. If that first reply fails, send it again.

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
