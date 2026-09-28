---
name: email-rendering-pattern
description: Recurring gap in operator e-mail/digest rendering: link stripping and inertText applied to some untrusted fields but not all (titles, model "dropped"/diagnostic strings)
metadata:
  type: feedback
---

When an agent renders untrusted or model text into an e-mail, every field must get the same treatment: strip links (`https?://`, `www.`), then `inertText()` (one line, no control/format chars, clipped). Check the "diagnostic" fields most carefully: `dropped`/rejected-suggestion lists, error strings, titles. They are the ones authors forget because they feel like metadata.

**Why:** In the triage review (2026-09-28) `summary` was sanitized but issue titles kept links and model-controlled `dropped` entries were raw slices of model output, so an injection could put a phishing URL or fake digest lines into the operator's inbox while the doc claimed the control existed.

**How to apply:** For any digest/notification renderer, list every interpolated value and its source; anything not from code constants or validated enums/numbers must pass the same sanitizer. Prefer sanitizing at validation time (one place) over at render time. Also check that `inertText`'s character class covers `\p{Cc}` and `\p{Cf}`, not a hand-picked subset.
