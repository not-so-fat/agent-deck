# MCP card — edit custom headers — design

**Status:** Implemented  
**Date:** 2026-08-03  
**Product:** agent-deck  
**Decision:** Always-visible Custom Headers editor on the remote MCP service details card; update via existing `PUT /api/services/:id`. Secrets stay on the service card (not credential-vault linking for this change).

---

## 1. Problem

Remote MCP servers often authenticate with custom HTTP headers (Bearer / API key). Users can set headers at **registration**, but the service details modal only **displays** them — and only when `service.headers` is non-empty.

When the key is wrong or missing:

1. There is no UI to fix headers (workaround: raw `PUT`).
2. The **Custom Headers** badge/block disappears entirely (gated on non-empty `headers`), so the card does not even hint that header auth is involved.

Example: Docmost-style MCP, unhealthy, no OAuth path.

---

## 2. Goals / non-goals

### Goals

- On the **MCP card details** surface, let users **view and edit** `service.headers` in place.
- Always show the Custom Headers section for **remote `mcp`** services, including empty and unhealthy states.
- Reuse registration’s JSON editor UX; persist with existing `PUT /api/services/:id` `{ headers }`.
- Mask secret values in view mode; real values only while editing.

### Non-goals (v1)

- Credential vault attach / rotate as the primary fix path.
- Structured Bearer / API-key form fields.
- Replace-secret-only UX that never shows current values.
- Changing OAuth reconnect UI or local-mcp env editing.
- New API endpoints or header schema changes.

---

## 3. Locked choices

| Topic | Choice | Why |
|-------|--------|-----|
| Where to edit | MCP service details modal | User choice; matches “fix on the card” |
| Visibility | Always for remote `mcp` | Fixes missing Custom Headers when auth is broken |
| Editor shape | JSON object textarea (registration parity) | Smallest change; covers arbitrary header names |
| Persist | `PUT /api/services/:id` with `{ headers }` | Backend already supports it |
| Invalid JSON | **Frontend blocks submit** — show inline error, no PUT | User-locked; same spirit as registration validate-on-save |
| View secrets | Mask values; show header names | Avoid dumping tokens in the default view |
| Empty headers | Allowed (`{}` / clear) | User can remove auth headers |

---

## 4. UI behavior

### 4.1 Surface

- **Where:** Service details modal, under Endpoint (same region as today’s read-only Custom Headers block).
- **When:** `type === 'mcp'` (remote). Not required for `local-mcp` / A2A in v1.
- **Gate removed:** Do not require `Object.keys(headers).length > 0` to render the section.

### 4.2 View mode

- **Has headers:** List header names with masked values (e.g. `Authorization: Bearer ••••`, other secret-like values as `••••`). Keep the existing compact “Custom Headers” badge when headers are non-empty.
- **Empty:** Empty state copy: no custom headers; user can add Bearer / API key headers to authenticate. No badge when empty.
- **Edit** control opens edit mode (whether empty or not).

### 4.3 Edit mode

- Prefill textarea with current headers as pretty-printed JSON (real values) so key rotation is in-place edit.
- Free typing while editing (do not parse-on-every-keystroke in a way that blocks typing).
- **Save:**
  1. Parse JSON.
  2. If invalid JSON **or** not a string-valued object → show **inline frontend error**, **do not call PUT**, stay in edit mode.
  3. If valid → `PUT /api/services/:id` with `{ headers: parsed }`.
  4. On success: exit edit mode, invalidate service/deck/collection-warning queries; health/reconnect follows existing post-update patterns.
  5. On PUT failure: toast; stay in edit mode with draft preserved.
- **Cancel:** discard draft, return to view mode.
- Clearing to `{}` removes all custom headers (valid submit).

### 4.4 Unhealthy state

No separate flow. Section remains visible; user edits headers and saves. If reconnect still fails, stay unhealthy with section still available.

---

## 5. Backend

No contract change. Dashboard client already can read/write `headers` on services. Agent-facing payloads continue to redact secret headers (`sanitizeServiceForAgent`); this feature is dashboard-only UX.

---

## 6. Acceptance

1. Remote MCP with `headers` null/empty still shows Custom Headers + empty state + Edit.
2. Remote MCP with only `Authorization`, including when unhealthy, shows the section (names + masked values).
3. User can replace a bad Bearer/API key via Edit → Save; value persists and is used on the next MCP call.
4. User can clear headers entirely via valid `{}`.
5. Invalid JSON (or non-string map) **cannot be submitted** — frontend shows error and stops (no PUT).
6. Local-mcp / non-MCP cards and OAuth panel unchanged.

---

## 7. Tests

- UI: section visible when headers are null/empty.
- UI: Save with invalid JSON shows error and does not call `apiRequest` PUT.
- UI: Save with valid object calls PUT with parsed headers.
- Backend: rely on existing `updateService` headers coverage; add only if gaps appear.

---
