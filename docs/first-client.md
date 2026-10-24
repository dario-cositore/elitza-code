# First client

The whole AI Enablement loop, from a town and a trade to a paid, delivered job. Every step is a tool Elitza calls; you approve the one step that reaches a human being.

Back to the [README](../README.md), or see [guided setup](guided-setup.md) and [handover](handover.md).

## What never happens on its own

- No email leaves this machine until you approve a batch of drafts.
- No write to a live domain without explicit confirmation.
- No secret in a document, a prompt or a memory.

## 1. Scout

```text
client_scout: location = "Castelleone, Cremona, Italy", query = "dentist", limit = 10
```

Returns name, address, phone, website, rating, review count, category and a Maps link per business, straight from the official Google Places Text Search API with your own `GOOGLE_MAPS_API_KEY`. Read-only: it stores nothing and contacts nobody.

## 2. Qualify into the CRM

```text
crm add: name = "Studio Rossi", vertical = "dental", status = "scouted",
         score = 72, website = "...", address = "...", phone = "...", source = "places"
```

Scores are 0-100: how well they fit what you sell (budget signal, volume, whether their pain is one you can fix in a sprint). The same website or name-plus-address never creates a second row.

```text
crm find_email: id = 1
```

Places does not hand out email addresses, so this reads the client's own website for a public one. It returns nothing rather than guessing an address that would only bounce.

## 3. First touch

```text
outreach add:    client_id = 1
outreach draft:  client_id = 1, subject = "...", body = "..."
```

The draft lands as a file in `~/.elitza/pipeline/<date>/C1-<slug>.md` with the opt-out footer already written in. Read it, edit it if you want, then:

```text
outreach approve: ids = [1]
outreach send:    ids = [1]
```

Sending needs `RESEND_API_KEY` and `RESEND_FROM`. Only approved rows send: an unapproved draft is refused with a reason, never a silent success. After the send the client is `contacted`, `last_contact` is set, the interaction is recorded, and the next touch is scheduled three days out.

## 4. The cadence (four touches, then silence)

| When | Stage after it goes out |
| --- | --- |
| day 0 | `contacted` |
| +3 days | `followup_1` |
| +7 days | `followup_2` |
| +14 days | `followup_3` |

The heartbeat drafts every due follow-up as a `Re:` file in the same thread and never sends it:

```text
outreach due      what is due today
outreach queue    draft them now (the heartbeat does this each tick)
outreach approve  review the batch
outreach send     send the batch
```

One follow-up is never drafted twice while the previous one still waits for review. Disable the pass entirely with `ELITZA_FOLLOWUPS=0`.

## 5. Disposition

```text
outreach dispose: id = 1, verdict = "yes", note = "asked for a pilot"
```

| Verdict | Pipeline stage | Client goes to |
| --- | --- | --- |
| `yes` | `yes` | `diagnose` (production starts) |
| `no` | `no` | `stale` (newsletter and nurture) |
| `stale` | `stale` | `stale` |

Every verdict cancels the cadence: no scheduled touch, nothing left approved, a waiting draft de-queued. After four silent touches the sweep closes the row itself (`outreach sweep`, also run by the heartbeat) and the client joins the stale list.

```text
crm search: status = "stale"
```

That list is your newsletter and nurture audience.

## 6. Production

```text
production where:         id = 1
production advance:       id = 1, stage = "proposal", asset_path = "..."
production schedule_call: id = 1, when = "2026-11-03T10:00:00Z"
production record_payment: id = 1, amount = 2500, invoice_path = "..."
production advance:       id = 1, stage = "done"
```

Stages in order: `diagnose → proposal → workbook → scheduled → payment → done`. Only a `yes` gets a client in here. Each move rewrites the client's next action, logs an interaction, and can attach the artifact that stage needs (proposal, workbook, invoice). `record_payment` records money and the invoice file; it charges nobody, because the payment processor is still an open decision. The done queue is:

```text
crm search: status = "done"
```

Price bands used throughout, in euros: **€1,500** single flow, **€2,500** two or three flows with a CRM, **€3,500** document processing with retention and access rules. Payment is 50% to start, 50% on handover; delivery starts when the first payment is recorded.

## 7. Read the playbook first

```text
playbook list
playbook read: name = "ai-enablement-diagnosis"
```

Six playbooks ship with her (diagnosis, proposal, workbook library, call script, payment terms, handover) and each is also a skill she pulls in on her own. Drop your own `.md` into `~/.elitza/brain/procedural/` and it joins the library; nothing you edit there is ever overwritten.

## 8. Hand over

When the work is delivered, generate the document the buyer keeps: [handover](handover.md).
