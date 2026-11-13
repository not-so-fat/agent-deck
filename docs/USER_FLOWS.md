# Typical user flows

**Status:** Living map · **Owner of:** the end-to-end journeys a user (or an agent acting for them) takes through Agent Deck · **Last aligned:** 2026-11-03

This file answers one question: *what do people actually do with this product, start to finish?* Other docs own the details of each step ([MVP.md](./MVP.md) for tools and behavior, [SETUP.md](./SETUP.md) for install and dashboard); this file owns the **sequence**, so a new contributor, an agent, or an evaluation tool can find the real workflows in one place. A playbook for maintaining it ("Maintaining user flows") is proposed for the builder deck and becomes the owner of the upkeep rules once accepted.

**Rule:** a flow links to the owner doc for every fact. It never restates tool schemas, flags, or file layouts.

## Actors

| Actor | Who |
|-------|-----|
| **User** | One person on macOS who works with several coding agents and workspaces (D2 in [DIRECTION.md](./DIRECTION.md): single-user, local-first). |
| **Agent** | A coding agent (Claude Code, Codex, Cursor, muse) connected to the Agent Deck MCP endpoint. |
| **Dashboard** | The browser UI opened with `agent-deck open`. |
| **Orchestrator** | An agent that delegates work to another agent session (F7). |

## Flow index

| ID | Flow | Status |
|----|------|--------|
| [F1](#f1-cold-start-install-to-first-deck) | Cold start: install to first deck | Shipped |
| [F2](#f2-open-a-session-on-the-right-deck) | Open a session on the right deck | Shipped |
| [F3](#f3-teach-a-procedure-once-reuse-it-everywhere) | Teach a procedure once, reuse it everywhere | Shipped |
| [F4](#f4-correct-the-agent-review-the-lesson) | Correct the agent, review the lesson | Shipped |
| [F5](#f5-switch-deck-mid-session) | Switch deck mid-session | Shipped |
| [F6](#f6-connect-a-service-or-key-and-attach-it-to-a-deck) | Connect a service or key and attach it to a deck | Shipped |
| [F7](#f7-delegate-a-task-to-another-agent) | Delegate a task to another agent | Shipped |
| [F8](#f8-carry-decks-to-another-machine) | Carry decks to another machine | Shipped |
| [F9](#f9-create-an-evaluation-scenario-from-feedback) | Create an evaluation scenario from feedback | Shipped (manual) |
| [F10](#f10-check-that-a-playbook-change-helps) | Check that a playbook change helps | Partial |

Adjacent, not owned here: **agent-dealer** (issue queue, plan approval, review) lives in its own repo; its entry point from this product is [FRIEND_PATH.md](./FRIEND_PATH.md) steps 5–6. **Personal cloud hosting** is proposed work ([personal-cloud design](./superpowers/specs/2026-10-02-personal-cloud-agent-deck-design.md)), not a shipped flow.

---

## F1. Cold start: install to first deck

- **Actor / goal:** User, new machine. Get one working deck an agent can see.
- **Trigger:** The user wants to stop re-teaching each agent how they work.
- **Preconditions:** macOS, a supported Node.js ([SETUP.md](./SETUP.md)), one signed-in agent client.

| # | User or agent does | Observable result |
|---|--------------------|-------------------|
| 1 | Install Agent Deck and start the daemon ([Quick Start](../README.md#quick-start)) | `agent-deck --version` prints a version; the daemon is running |
| 2 | `agent-deck open` | Dashboard opens showing **My Decks** and **My Collection** |
| 3 | In the dashboard: **My Decks → create a deck**, drag cards on | Deck appears under **My Decks** |
| 4 | `agent-deck setup` for your client ([SETUP.md](./SETUP.md)), restart the host | Host lists `agent-deck` as connected |
| 5 | Optional and being phased out: `agent-deck use <deck>` in a repo | `.agent-deck/use.json` written; next session in that folder opens on that deck (continues in F2). Planned: sessions without a pin bind to your default deck, so this step is not needed; see [one default deck](./design/optional-folder-binding.md) |

- **Success:** the host shows the deck badge, or the agent names the bound deck when asked.
- **Common failures:** dashboard shows a recovery view, or MCP says no deck is selected: see [SETUP.md](./SETUP.md) Dashboard and troubleshooting.
- **Owner docs:** [README Quick Start](../README.md#quick-start), [FRIEND_PATH.md](./FRIEND_PATH.md), [SETUP.md](./SETUP.md), [AGENT_HARNESS.md](./AGENT_HARNESS.md).

## F2. Open a session on the right deck

- **Actor / goal:** Agent, first turn of any session. Learn which deck governs this session and what it can use.
- **Trigger:** A session starts in a folder with Agent Deck configured.

| # | Agent does | Observable result |
|---|------------|-------------------|
| 1 | Calls `get_session_context` before touching the repo | Returns the session's deck context, including playbook summaries and the deck's operating instructions |
| 2 | Prints `display_summary` as exactly one line | Transcript shows the deck receipt line |
| 3 | Matches the task against playbook triggers, calls `get_playbook` for each match | Procedure body is in context before any task action (continues in F3) |
| 4 | Follows the deck's `operatingInstructions` | Role and scope rules apply for this session |

- **Success:** one receipt line, no deck chosen by the agent, playbooks fetched before acting.
- **Common failures:** tool unavailable or `GRANT_REQUIRED` → agent stops and reports the connection problem rather than improvising.
- **Owner docs:** [agent-deck-session skill](../skills/agent-deck-session/SKILL.md), [MVP.md](./MVP.md) Module 1, [MCP_SESSION_LIFECYCLE.md](./MCP_SESSION_LIFECYCLE.md), [MONOREPO_SCOPE.md](./MONOREPO_SCOPE.md).

## F3. Teach a procedure once, reuse it everywhere

- **Actor / goal:** User and agent. Turn a repeated procedure into a playbook any agent follows.
- **Trigger:** The user explains the same procedure (release checklist, PR rules, ticket format) a second time.

| # | User or agent does | Observable result |
|---|--------------------|-------------------|
| 1 | User describes the procedure in chat; agent registers the playbook | Playbook card appears in **My Collection** |
| 2 | Playbook is attached to a deck (dashboard drag, or agent-assisted) | Card shows on the deck; `get_session_context` lists its triggers |
| 3 | In a later session on any agent, the user's request matches a trigger | Agent calls `get_playbook` and follows the body |

- **Success:** a second agent or workspace follows the same procedure with no re-teaching.
- **Common failures:** trigger phrases too narrow or colliding with another playbook (trigger-conflict detection, [design](./superpowers/specs/2026-07-12-playbook-trigger-conflict-design.md)); agent improvises without fetching.
- **Owner docs:** [MVP.md](./MVP.md) Module 3, [PLAYBOOKS_AND_SKILLS.md](./PLAYBOOKS_AND_SKILLS.md), [agent-deck-playbooks skill](../skills/agent-deck-playbooks/SKILL.md).

## F4. Correct the agent, review the lesson

- **Actor / goal:** User corrects an agent; the lesson becomes a reviewable change to a playbook.
- **Trigger:** The user rejects or fixes output from a playbook-driven task, or from a task no playbook covered.

| # | User or agent does | Observable result |
|---|--------------------|-------------------|
| 1 | User corrects the output; agent fixes it | Corrected result in the session |
| 2 | Agent files a playbook patch proposal with the user's own words as evidence ([agent-deck-playbooks skill](../skills/agent-deck-playbooks/SKILL.md)) | One-line notice: proposal filed |
| 3 | User opens the dashboard review queue (`/playbook-patches`) | Item-level diff with the user's own words beside it |
| 4 | User accepts or rejects (rejection needs a reason) | Accepted: playbook updated and a version recorded. Rejected: reason kept as signal |
| 5 | Next session fetches the playbook | The lesson applies |

- **Success:** the same correction is not needed twice.
- **Common failures:** anchor no longer matches (patch becomes `stale`, re-propose); agent never fetched the playbook so no signal is filed.
- **Owner docs:** [learning-loop design](./superpowers/specs/2026-07-11-playbook-learning-loop-design.md), [LEARNING_LOOP_TEST_SCENARIOS.md](./LEARNING_LOOP_TEST_SCENARIOS.md), [2026-07-22 feedback table](./superpowers/specs/2026-07-22-feedback-signals-table-redesign.md), [no-backend-llm-boundary.md](./decisions/no-backend-llm-boundary.md).

## F5. Switch deck mid-session

- **Actor / goal:** User moves one running session to a different deck (e.g. dev to personal).
- **Trigger:** The user says "switch to my personal deck".

| # | User or agent does | Observable result |
|---|--------------------|-------------------|
| 1 | Agent calls `switch_deck` with the deck name | Pending approval request; active deck unchanged |
| 2 | User approves the switch in the dashboard or host prompt | Request consumed |
| 3 | Agent calls `get_session_context` once and prints the new receipt line | New deck's services, playbooks, and instructions apply; the old deck's instructions stop |

- **Success:** exactly one new receipt line; no MCP reconnect.
- **Common failures:** `DECK_FIXED` or `ADMIN_REQUIRED`: the agent tells the user instead of retrying (handling in the [agent-deck-run skill](../skills/agent-deck-run/SKILL.md)).
- **Owner docs:** [session-deck-switching design](./superpowers/specs/2026-09-20-session-deck-switching-redesign.md), [MVP.md](./MVP.md).

## F6. Connect a service or key and attach it to a deck

- **Actor / goal:** User gives a deck access to an external tool (Linear, Notion, Slack, an API key).
- **Trigger:** A playbook or task needs a tool the deck does not have.

| # | User does | Observable result |
|---|-----------|-------------------|
| 1 | In **My Collection**, register an MCP server (remote URL, local stdio, or pasted JSON) or an API key | Card appears in the collection (secret handling: [ARCHITECTURE.md](./ARCHITECTURE.md)) |
| 2 | For OAuth services, click **Connect** and finish in the browser | Card health turns healthy |
| 3 | Drag the card onto the deck | Agents on that deck see the service via `call_service_tool` |
| 4 | For scripts, run the command through `agent-deck exec` ([MVP.md](./MVP.md) Module 2) | Command runs with the key injected, no `.env` |

- **Success:** the agent calls the service with no key in chat or repo.
- **Common failures:** unhealthy service (card health shows it; see [SETUP.md](./SETUP.md) troubleshooting); deleting a card a playbook depends on warns.
- **Owner docs:** [MVP.md](./MVP.md) Module 2, [SETUP.md](./SETUP.md) Dashboard, [OAUTH_AND_HOSTING.md](./OAUTH_AND_HOSTING.md), [ARCHITECTURE.md](./ARCHITECTURE.md).

## F7. Delegate a task to another agent

- **Actor / goal:** Orchestrator hands a bounded task to a signed-in agent on the same deck and workspace, then reviews the result.
- **Trigger:** The user asks one session to hand work to another.

| # | Orchestrator does | Observable result |
|---|-------------------|-------------------|
| 1 | Writes a brief; the user names the deck (the orchestrator never picks it) | Brief with scope and a tool profile per the run skill |
| 2 | `start_run` | `runId` and `sessionId` returned |
| 3 | `get_run` until terminal | Ordered events, then `ended` or `died` |
| 4 | Reviews, then `start_run` with `resumeSessionId` to continue, or `cancel_run` | Same session continues under a new run, or the run stops |

- **Success:** result reported with `runId`, `sessionId`, tool profile, and terminal state.
- **Common failures:** `WORKSPACE_REQUIRED`, `CLIENT_UNAVAILABLE` → report and stop (rules in [DELEGATION.md](./DELEGATION.md)).
- **Owner docs:** [agent-deck-run skill](../skills/agent-deck-run/SKILL.md), [MCP_RUN_TOOLS.md](./MCP_RUN_TOOLS.md), [DELEGATION.md](./DELEGATION.md), [AGENT_RUN_API.md](./AGENT_RUN_API.md).

## F8. Carry decks to another machine

- **Actor / goal:** User restores or shares decks on a new laptop.
- **Trigger:** New machine, backup before upgrade, or sharing a deck layout.

| # | User does | Observable result |
|---|-----------|-------------------|
| 1a | Sync the store through your own private Git repo, then reindex ([STORE_FORMAT.md](./STORE_FORMAT.md) says what is committed and what is not) | Same decks, MCP cards, playbooks |
| 1b | Or export a bundle on one machine and import it on the other ([PRD_EXPORT_IMPORT.md](./PRD_EXPORT_IMPORT.md)) | Layout restored; conflicts are reported, not overwritten |
| 2 | Re-enter API keys and reconnect OAuth | Import report lists what needs reconnecting |

- **Success:** equivalent layout, with no secrets ever in the bundle.
- **Owner docs:** [STORE_FORMAT.md](./STORE_FORMAT.md), [PRD_EXPORT_IMPORT.md](./PRD_EXPORT_IMPORT.md).

## F9. Create an evaluation scenario from feedback

- **Actor / goal:** User turns past corrections about one playbook into a reusable test case.
- **Trigger:** Several correction signals (from F4) point at the same playbook, or a patch is worth testing before accepting.
- **Status:** Shipped for manual curation. Agent-drafted scenarios are not built.

| # | User does | Observable result |
|---|-----------|-------------------|
| 1 | Open the dashboard **Feedback** page and filter to one playbook | Table of correction signals with excerpt, failure summary, source and time |
| 2 | Select the signals that describe the same failure | **Create scenario** enables only when the selection is eligible, otherwise a reason is shown |
| 3 | In the scenario editor, fill in the task input, the historical failed output, and deterministic expectations | The source signals sit beside the form so the user's own words stay visible |
| 4 | Save as draft, or mark ready | Scenario appears in the **Scenarios** view with its playbook, signal count and check count |
| 5 | In **Scenarios**, edit, mark ready, retire, or copy a ready scenario's case JSON | The copied JSON is what F10 consumes |

- **Success:** a ready scenario that names its playbook, its source signals, and checks that can pass or fail without a model.
- **Known gap:** feedback rows keep the correction but not the original failed output, so the user must supply that evidence by hand or the scenario stays a draft ([rsi-feedback-smoke README](./examples/experiments/rsi-feedback-smoke/README.md)).
- **Owner docs:** [EVALUATION_SCENARIOS_API.md](./EVALUATION_SCENARIOS_API.md), [2026-07-22 feedback table](./superpowers/specs/2026-07-22-feedback-signals-table-redesign.md), [no-backend-llm-boundary.md](./decisions/no-backend-llm-boundary.md).

## F10. Check that a playbook change helps

- **Actor / goal:** User decides whether a playbook edit is an improvement, using F9 scenarios as test cases.
- **Trigger:** A ready scenario exists and a candidate playbook change is on the table.
- **Status: partial.** A deterministic evaluator ships; producing candidate outputs and promotion stay manual by design.

| # | User does | Observable result |
|---|-----------|-------------------|
| 1 | Put the copied case JSON into an experiment definition | Experiment under `docs/examples/experiments/` shape |
| 2 | Produce candidate outputs outside the evaluator | Output files |
| 3 | `agent-deck experiment evaluate` on the experiment | Pass/fail per deterministic expectation |
| 4 | Optionally run an agent against a pinned playbook version ([DELEGATION.md](./DELEGATION.md)) | Run uses exactly that version |
| 5 | Accept or reject the patch in F4 | Human decision; nothing is promoted automatically |

- **Owner docs:** [EVALUATION_SCENARIOS_API.md](./EVALUATION_SCENARIOS_API.md), [examples/experiments/](./examples/experiments/), [no-backend-llm-boundary.md](./decisions/no-backend-llm-boundary.md).
