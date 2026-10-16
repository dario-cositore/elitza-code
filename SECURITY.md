# Security

## Reporting

Report suspected vulnerabilities privately with GitHub Security Advisories on this repository. Include the affected
version, reproduction steps, and impact.

Reports written by a human who actually reproduced the issue are prioritized. Bulk AI-generated reports with no real
reproduction will be closed.

## Threat model in one paragraph

Elitza is a local agent: it holds your provider keys under `~/.elitza`, runs commands you approve, and reads/writes
files in your projects. It phones home only to the provider endpoint you configured (for example OpenRouter) and to
fetch its own update metadata. Session data and memory (`soul.db`) stay on your machine. Review the permissions
prompts in the TUI — every command and file write can be gated.
