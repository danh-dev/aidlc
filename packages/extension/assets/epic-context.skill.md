---
name: epic-context
description: Load and maintain an epic's compact memory so continuing it (with any agent) is cheap on tokens. Reads docs/epics/<epic>/epic-memory.json FIRST as primary context, appends durable decisions/constraints as you work, and records a reflection on how to prompt/work better next time. Invoke /epic-context <epic> when starting or continuing an epic.
---

# /epic-context — cheap, portable epic memory

Every epic can carry a compact memory at `docs/epics/<epic>/epic-memory.json`:
- `summary` — one paragraph: what the epic is + where it stands
- `entries[]` — distilled **decisions / constraints / context / notes**
- `reflections[]` — lessons on how to **prompt/work more effectively next time**

The point: a future session (any agent) reads this digest FIRST instead of
re-reading every artifact + git history — far fewer tokens. So keep it compact
and high-signal; it is a digest, not a transcript.

The tool ships with the AIDLC extension at `~/.claude/tools/epic-memory.mjs` and
runs with just `node`. Let `M = node "$HOME/.claude/tools/epic-memory.mjs"`.
Each write is auto-attributed (git identity, hostname fallback) + timestamped.

## Arguments

`/epic-context <epic>` — e.g. `/epic-context EPIC-001`. Paths are relative to the
open project: `EPIC_DIR = docs/epics/<epic>`.

## On start (continuing an epic)

1. **Load memory first**: `$M show "$EPIC_DIR"`.
   - If it prints a digest, treat it as your primary context. Only open the full
     artifacts (`$EPIC_DIR/artifacts/*.md`) for the specific parts the memory
     doesn't already cover — don't re-read everything.
   - If it says "no epic memory yet", fall back to reading the artifacts, and
     seed a summary once you understand the epic: `$M summary "$EPIC_DIR" --text "…"`.

## While working

Append durable, reusable facts as you make them (not chit-chat):
- `$M add "$EPIC_DIR" --kind decision   --text "Chose X over Y because …"`
- `$M add "$EPIC_DIR" --kind constraint --text "Must not touch Z / must keep …"`
- `$M add "$EPIC_DIR" --kind context    --text "Key fact a newcomer would need"`

Keep the summary current when the epic's state changes materially:
`$M summary "$EPIC_DIR" --text "…"`.

## At the end (or when the user gives notable feedback)

Record a reflection so the next session prompts/works better:
`$M reflect "$EPIC_DIR" --text "Next time: state target files + expected result up front to avoid back-and-forth"`.

## Guardrails

- Compact and high-signal — this file exists to *save* tokens, so don't dump raw
  prompts or long transcripts into it.
- It complements, never replaces, the `.md` artifacts (still canonical).
- Safe to commit: it travels with the epic so any teammate/agent benefits.
