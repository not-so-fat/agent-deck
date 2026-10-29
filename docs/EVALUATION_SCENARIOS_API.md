# Evaluation scenarios API

Evaluation scenarios persist manually curated, feedback-derived cases for one target playbook. They are intentionally exposed through the dashboard-authenticated REST API only; this slice adds no MCP tools, suites, runs, or automatic transcript resolution.

All responses use `{ "success": true, "data": ... }` or `{ "success": false, "error": "..." }`.

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/api/evaluation-scenarios` | Create a scenario. `id` is optional and `status` defaults to `draft`. |
| `GET` | `/api/evaluation-scenarios/:id` | Get one scenario; returns `404` when absent. |
| `GET` | `/api/evaluation-scenarios` | List scenarios. Optional filters: `targetPlaybookId` and `status`. |
| `PUT` | `/api/evaluation-scenarios/:id` | Partially update a scenario; returns `404` when absent. |

The stored shape is:

```json
{
  "id": "es_review_blocker",
  "targetPlaybookId": "pb_review_a_pull_request",
  "name": "Preserve blocking findings",
  "taskInput": "Review this pull request.",
  "historicalFailedOutput": "Looks good.",
  "expectations": [
    { "id": "mentions-blocker", "type": "contains", "value": "blocking" }
  ],
  "sourceSignalIds": ["fs_first", "fs_second"],
  "status": "ready",
  "createdAt": "2026-10-29T12:00:00.000Z",
  "updatedAt": "2026-10-29T12:00:00.000Z"
}
```

Expectation types match the deterministic experiment evaluator: `contains`, `not_contains`, and `equals` accept optional `caseSensitive`; `regex` accepts optional `flags` (`i`, `m`, `s`, `u`, without duplicates).

Drafts may omit task/output evidence, signals, and expectations. A scenario can enter `ready` only when `taskInput` and `historicalFailedOutput` are non-empty and it has at least one existing feedback signal plus one deterministic expectation. Target playbook and source feedback-signal IDs must reference existing rows for every create or update.
