# Service Tool Result Normalize — Design

> **Historical (2026-07-14)** — This record captures an earlier design, proposal, or verification run. See [the current guide](../../ARCHITECTURE.md) for shipped behavior.


**Date:** 2026-07-14 · **Status:** Approved · **Scope:** `packages/backend` MCP proxy (`callServiceTool` success path)

**Problem:** Proxied MCP tool results pass through verbatim. Two failures surfaced via Slack `slack_read_file`:

1. In-band tool errors (`isError` / `file_not_found`) ride `success: true` and bypass `classifyMcpErrorCode`, so agents retry as if the ID were wrong — including Slack Connect external-org uploads that will never succeed with the workspace token.
2. Binary / oversized payloads (base64 PDFs) are pretty-printed into one text block by `toolResult()`, blowing host tool-output limits.

**Goal:** After every remote/local MCP `callTool`, normalize the result once: surface in-band errors as `success: false`, spill binaries and large payloads to disk, return a small metadata object agents can open with a normal file read.

**Out of scope:** Permalink / `url_private_download` fetch; A2A spill; TTL sweeper for spilled files; changes to Slack’s hosted MCP.

**Related:** Issue note (Obsidian) *Agent Deck — Slack read_file — External Connect Uploads Unreadable + Binary Blob Overflow*; [SLACK_READ_WORKAROUND.md](../../SLACK_READ_WORKAROUND.md)

---

## 1. Choke point

```
callServiceTool → mcpClient.callTool → normalizeServiceToolResult → ServiceCallResult
```

- Apply to `mcp` and `local-mcp` only.
- A2A path unchanged in v1.
- HTTP `/api/services/:id/call` and MCP `call_service_tool` both benefit.

---

## 2. In-band error enrichment

Treat as failure when:

- `result.isError === true`, or
- Flattened text matches `/file_not_found|execution_failed/i`, or
- Structured `{ error: string }` shape in content

Return:

```ts
{
  success: false,
  error: <short label from remote>,
  error_code: 'MCP_TOOL_ERROR',
  details: {
    service_id, service_name, remote_url, tool_name,
    cause: <remote text>,
    phase: 'callTool',
    hint?: string,  // optional
  },
  serviceName, toolName,
}
```

**Slack Connect hint** when service name or URL matches `/slack/i` **and** cause matches `/file_not_found/i`:

> Possibly an external Slack Connect file — bytes may be unreachable with this token; retry will not help. Ask an internal member to re-upload or share a download link.

Do not hard-code service IDs. Do not mark the service unhealthy (unlike transport `catch` — the MCP session is fine).

---

## 3. Spill to disk

**Dir:** `path.join(resolveAgentDeckHome(), 'tool-results')` (create on demand).

**Spill when any of:**

1. MCP content block type is `image` / `resource` / `blob`, or mime is `image/*`, `audio/*`, `video/*`, `application/pdf`, `application/octet-stream`
2. A string looks like base64 (≥ 256 chars, base64 charset) with meaningful decoded length
3. `JSON.stringify(result)` length ≥ **48_000**

**Spilled success shape:**

```ts
{
  success: true,
  result: {
    spilled: true,
    path: string,
    mimeType: string,
    size: number,
    originalTool: string,
  }
}
```

Write **decoded bytes** when base64; otherwise UTF-8 of the serialized payload. Prefer a sensible extension from mime (`.pdf`, `.bin`, `.txt`, …). Filename: `<uuid><ext>`.

No TTL cleanup in v1.

---

## 4. Compact tool text

`mcp-server` `toolResult` drops pretty-print (`JSON.stringify(data)` without `null, 2`) to avoid per-call whitespace tax on all tools. Spill already shrinks binary cases; compact helps everything else.

---

## 5. Schema

Extend `ServiceToolErrorDetails` / Zod schema with optional `hint?: string`.

---

## 6. Tests

Pure normalizer unit tests:

- Small text → passthrough `success: true`
- `isError` + Slack + `file_not_found` → `success: false` + hint
- Non-Slack `file_not_found` → no Connect hint
- Oversized / base64 → file exists + metadata
- Transport-style failures remain on existing `catch` path (regression in `service-manager.test.ts`)

---

## 7. Recommendation locked

| Item | Choice |
|---|---|
| Scope | Problem 1 + Problem 2 together |
| Spill policy | Clear binaries always + any payload ≥ 48 KB |
| Location | `callServiceTool` post-call normalize |
| Change 3 (permalink) | Dropped |
