# Handover

When a job is delivered, the buyer gets `CLIENT_SOP_HANDOVER.md`: the document that says what runs where, which environment variables it needs, how to run and check it, what to do when something breaks, what needs a human yes, and who owns it afterwards.

Back to the [README](../README.md), or see [guided setup](guided-setup.md) and [first client](first-client.md).

## Generate it

```text
handover: repo = "/path/to/the/project", client_id = 12
```

Defaults: `repo` is the working directory, the file is written as `CLIENT_SOP_HANDOVER.md` at the repo root. Pass `out` to write it somewhere else (a scratch folder while you review, for instance).

The tool reports what fed the document, honestly: how many commits it referenced and how many environment variable names it listed. An empty git history is stated as a fact, not hidden.

## What is in it

| Section | Where the content comes from |
| --- | --- |
| Architecture | `package.json` (or the folder name), top-level layout, `git remote`, `git status`, and the last 15 commits quoted as `hash date subject` |
| Environment and secrets | a scan of tracked source for `process.env.X`, `os.environ` and `.env.example` declarations |
| Daily operation | the CRM client, plus the run and check commands from `package.json` scripts |
| Maintenance | what to update, how often, and the rule that this file goes stale after any structural change |
| Edge cases and recovery | git as the recovery path, startup checks, database restore, and "if this document disagrees with the code, the code wins" |
| Approval gates | the `permission` block really in `opencode.json`, your own `permission_gates` answer from `/start`, plus the standing rules |
| Support and ownership | where the code lives and what the buyer owns |

Section headings match the `client-handover` playbook, so the generator and the teaching layer describe the same document.

## The rule that matters

**Names only, never values.** A variable like `RESEND_API_KEY` appears as a name with the note that its value lives in a mode-600 file. The generator never writes a key, a token or a password into the document, and never invents one to fill a gap.

## When to run it

- After delivery, together with the final payment (the payment-terms playbook pairs the two).
- After any structural change to the project: it is generated from evidence, so it is only correct as long as that evidence is.
- Before you walk away from a project for good, even for a small one.

## What it does not do

- It produces Markdown, not PDF: the file is meant to be read, diffed and edited in the buyer's own repository.
- It does not read your memory of the project. If git and this document disagree, regenerate it.
