# Trigger count grandfather (update path) — Design

**Status:** Approved  
**Date:** 2026-07-29  
**Related:** [trigger-conflict-detection](./2026-07-12-trigger-conflict-detection-design.md), file-backed store migrate (store codecs already uncapped)

## Problem

`MAX_TRIGGERS_PER_PLAYBOOK = 16` was applied at every Zod write boundary, including update. Legacy SQLite rows can exceed 16. Any update that re-submits triggers (or stub sync that re-normalizes them) hard-fails — playbooks become uneditable. Users have no practical way to fix a 20-trigger list in place.

## Decision (approach B)

| Path | Rule |
|------|------|
| **Create** / genesis | Hard max **16**. |
| **Update** / `set_triggers` | Allow if `count ≤ 16` **or** `count ≤ previousCount` (keep or shrink over-cap; never grow when over 16; never grow past 16 when under). |
| Body/title-only update | Do not re-validate stored triggers through the create cap. |
| **Stub sync** | Never throw on count; truncate description by character budget. |
| Store file codecs | Unchanged (already `maxCount: null`). |

## Who sees rejects

- **Agent (MCP / patch propose-accept):** structured / clear tool error with counts + hint; agent must fix the list and retry — **do not** ask the user to edit triggers.
- **Dashboard create (user typed triggers):** actionable inline/API error (“max 16 — remove extras”). User *can* act.
- **Soft banner** for over-cap cards is optional; never a forced trim modal.

## Enforcement locus

- Schema: create keeps capped `PlaybookTriggersSchema`; update / `set_triggers` normalize without count cap.
- Manager: `assertTriggerCountPolicy` on create (belt) and on update/patch when triggers change, using previous stored count.
- Routes: format agent vs dashboard client messages when catching `TriggerValidationError`.

## Non-goals

- Auto-trimming triggers on save
- Raising or removing the create-time 16 guide
- Blocking accept of patches that only shrink or keep over-cap lists
