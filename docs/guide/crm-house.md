# The CRM house

One web page for the whole pipeline: the board, the approval queue, the scout screen and every client record, served by the brain plugin itself. Same database, same modules, same rules as the terminal — there is no second CRM.

Back to the [README](../../README.md). See also [first client](first-client.md) for the loop itself and [the brain](../reference/brain.md) for the schema.

## Opening it

The house starts with the engine, from the plugin's setup hook, so it is already up whenever Elitza runs:

```bash
elitza serve          # prints "[crm-view] Elitza CRM house listening on http://127.0.0.1:8787"
elitza service start  # the background service brings it up too
```

The browser opens itself on first start. If you would rather it stayed quiet, set `CRM_VIEW_NO_OPEN=1`; to move it, set `CRM_VIEW_PORT` (default `8787`).

While working from source you can run it on its own:

```bash
cd packages/plugins/elitza-brain
bun run script/crm-view.ts
```

It loads `~/.elitza/.env` the same way the launcher does, so `XIAOMI_API_KEY`, `GOOGLE_MAPS_API_KEY` and `RESEND_API_KEY` are all available to the screens that need them. When the engine stops, the house stops with it.

> **It is a local tool, not a website.** The port has no login today and binds every interface, so treat it like any other unauthenticated local service: do not forward it to the internet. A loopback-only default is on the roadmap.

## The screens

| Screen | What is on it |
| --- | --- |
| **Pipeline** | Every client as a card, in one of the fourteen statuses from `scouted` to `done`. Click a card to open the client. |
| **Approval queue** | Drafts waiting for you: click the client name to open them, the file path to read the draft, then Approve or Send. Batch buttons at the bottom. Nothing here sends a single draft you have not approved. |
| **Scout** | Location, query and limit → live results with a `+ CRM` button that deduplicates against existing rows. |
| **Client detail** | Contact, deal, risk and firmographics, the Social block, the stage buttons, the communication shortcuts, the interaction timeline and the assets viewer. |

## Everything is a link

Website, email (`mailto:`), phone (`tel:`), address (Google Maps), the scout results, the enrichment output, and any URL typed into notes or an interaction body all render as real anchors. Draft paths in the queue open the file in the asset viewer instead of sitting there as text.

## The Social block

Each client carries four social columns — `linkedin`, `twitter`, `facebook`, `instagram` — declared in the schema and added to existing databases by migration when the house first opens them.

- **Read**: clickable chips at the top of the block.
- **Write**: one input per network plus **Save socials**, which patches the row through the same `updateClient` the `crm` tool uses.
- **Auto**: `enrich_client` regexes the client's own site for those four networks and writes whatever it finds.

Old databases need no hand migration: the columns appear on the first `crmDb()` open after an upgrade.

## Enrichment from the browser

The **Enrich** button on a client runs the full pass: fetch the homepage plus the usual subpages, extract public emails, phones and social profiles, then run MiMo over your diagnosis, proposal and payment playbooks. It writes back the notes, the risk assessment, tech stack, revenue and headcount estimates, the next action, and attaches `diagnosis.md` and `proposal.md` as assets. Expect 30 to 60 seconds. It never contacts the client.

## The JSON API

Everything the page does is a plain route over the same brain modules, so anything you build on top of it sees exactly what the terminal sees:

| Route | Does |
| --- | --- |
| `GET /api/clients` | list, `?status=` and `?q=` filters |
| `GET /api/clients/:id` | one client with interactions and assets |
| `POST /api/clients` | add (deduplicates on website, else name + address) |
| `POST /api/clients/update` | patch any field the `crm` tool can patch |
| `GET /api/drafts` | drafts waiting in the queue |
| `POST /api/approve`, `POST /api/send` | batch approval, then send the approved set |
| `POST /api/advance`, `/api/payment`, `/api/schedule` | drive the production stages |
| `POST /api/scout`, `POST /api/enrich` | scout a place, enrich a client |
| `POST /api/log`, `POST /api/asset` | record an interaction, read an asset file |

Asset reads are restricted to `~/.elitza`, `/tmp` and `~/.openclaw` — it is a viewer, not a file server.

## Guarantees

- One database (`~/.elitza/brain/crm.db`), one set of modules (`crm`, `outreach`, `production`, `scouting`, `enrichment`). The house and the TUI cannot disagree.
- No send without approval, exactly as in the terminal: an unapproved row comes back refused with a reason.
- Client PII stays out of the memory index, because the CRM is its own file.
