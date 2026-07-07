---
name: render-artifacts
description: Render an epic's Markdown artifacts to standalone annotation HTML (self-contained, Claude-style) for opening in an annotation tool. Invoke via /render-artifacts <epic>. Markdown stays canonical — HTML is a throwaway render, never a pipeline artifact.
---

# /render-artifacts — build annotation-ready HTML from epic artifacts

Markdown is the canonical source of every epic artifact (PRD, TECH-DESIGN, TEST-PLAN,
IMPLEMENTATION-PLAN…). The `produces:` paths in `workspace.yaml` all point at `.md`,
and agents/pipeline re-read `.md` because it is ~1.5–3× cheaper in tokens. This
command does **not** change that. It only produces a *throwaway* HTML render next to
each `.md` so a human can open the artifact in an annotation tool (e.g. annotron) and
comment on it.

Rule: **HTML is a render, not a source.** To change content, edit the `.md` and re-run.
Never add this step to a pipeline's `produces:`.

## Usage

`/render-artifacts <epic>` — e.g. `/render-artifacts EPIC-001`

## Steps

1. Resolve the artifacts folder: `docs/epics/<epic>/artifacts`. If it doesn't exist,
   stop and say so.
2. Run (zero-dep Node renderer; `marked` is vendored, so just `node` — no pip/python):
   ```
   node tools/md-to-html.mjs --all docs/epics/<epic>/artifacts
   ```
   This renders every `*.md` to a sibling `*.html` and rewrites cross-links between
   sibling artifacts (`PRD.md` → `PRD.html`), while leaving links that point outside
   the folder or to external URLs pointing at the canonical source.
3. Report the written files. Remind the user that the `.html` files are throwaway
   annotation copies — edit the `.md`, not the `.html`, and re-run to refresh.

## Committing

By default treat the HTML as local-only (throwaway). If the artifacts folder is
tracked in git and you don't want the renders committed, ensure the folder's
`.gitignore` contains `*.html`. Only commit an `.html` when the intent is to share a
specific annotated copy.

## Single file

To render one artifact:
```
node tools/md-to-html.mjs docs/epics/<epic>/artifacts/PRD.md
```
