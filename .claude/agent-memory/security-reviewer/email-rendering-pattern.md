---
name: email-rendering-pattern
description: Recurring gap in operator e-mail/digest rendering: link stripping and inertText applied to some untrusted fields but not all (titles, model "dropped"/diagnostic strings, Markdown link forms in paste-ready comments)
metadata:
  type: feedback
---

When an agent renders untrusted or model text into an e-mail, every field must get the same treatment: strip links (`https?://`, `www.`), then `inertText()` (one line, no control/format chars, clipped). Check the "diagnostic" fields most carefully: `dropped`/rejected-suggestion lists, error strings, titles. They are the ones authors forget because they feel like metadata.

Seen twice now:

- 2026-09-28 triage review: `summary` sanitized, titles kept links, `dropped` entries were raw model slices.
- 2026-10-01 specialists review: `verifyEvidence` pushed `evidence in "<model file name>"` into `dropped` with only `normalize()` (no link strip) and `digest.ts` joined `dropped` raw. Same shape, new module.

Second pattern: text the operator is meant to **paste into GitHub** (suggested comments) needs Markdown-aware sanitizing, not just `https?://` stripping: `[t](//host/x)`, `<a href=...>`, `<img src=...>`, reference-style `[t]: //host` all render as links/trackers on GitHub. Bare domains (`evil.example/x`) also get auto-linked by mail clients.

**Why:** A phishing URL or fake digest line in the operator's inbox is the main impact channel for a read-only agent; the doc claims the control exists, so a gap is a silent one.

**How to apply:** For any digest/notification renderer, list every interpolated value and its source; anything not from code constants or validated enums/numbers must pass the same sanitizer. Prefer sanitizing at validation time (one place) over at render time. For paste-ready Markdown, additionally strip `]\(...\)` destinations, HTML tags and `(^|\s)//\S+`.
