---
status: approved
linear: NOT-204
related: NOT-44, NOT-45, NOT-105, NOT-108, docs/PRD_TRUSTED_AGENT_SESSIONS.md
---

# Session/default deck-switching redesign (approved contract)

**Authority:** This document is the authoritative design contract for deck
switching. Older documents that describe admin-elevation-based or reload-based
switching are superseded by this contract for switching behavior and link back
here. Child implementation tickets must follow this document, not the older
descriptions.

**One-line summary:** Agents request a deck switch; humans approve it as
either **This session only** or **This workspace by default**. A
pending or declined request changes nothing and exposes nothing.

## 1. Problem

The shipped switching mechanism couples a deck change to admin elevation
(`agent-admin` / `ADMIN_REQUIRED`) plus an assignment-file rewrite, or to a
CLI `use` followed by an IDE/MCP reload. That conflates "let this session see
a different deck" with "change the workspace default", forces an elevation
round-trip for a routine context change, and leaves no explicit session-only
scope. Later tickets must not reinterpret which mechanism applies.

## 2. Approved mechanism

### 2.1 Request vs. decision

- The **agent** may only *request* a switch to a named deck. The request names
  the target `deckId` and the requesting session; it grants nothing by itself.
- The **human** makes the decision at approval time and picks exactly one of
  two commit scopes:
  - **This session only** — rebind only the requesting session to the target
    deck. The workspace default (folder assignment file / launch-selected
    deck) is untouched; peer sessions are unaffected.
  - **This workspace by default** — rebind the requesting session **and**
    update the workspace default to the target deck so future sessions start
    there. Peer sessions pick up the new default on their next connect; they
    are not force-migrated mid-session.

### 2.2 Containment invariant (hard)

While a switch request is **pending** or after it is **declined**:

- the requesting session keeps serving its currently bound (active) deck;
- the active deck binding does not change;
- the requesting session (and no other surface) exposes none of the target
  deck's services, credentials, or playbooks — no tool listing, no invocation,
  no playbook body or trigger content from the target deck.

Only an explicit human approval under 2.1 moves the session (and, for the
workspace scope, the default). Expiry or denial returns the request to
no-effect; the agent reports the outcome and continues on the active deck.

### 2.3 Presentation order

Approval UI must be offered in this order, first supported surface wins:

1. **Host-native MCP form** — when the host supports an MCP approval/elicitation
   form, present the switch request there with both scopes
   (**This session only** / **This workspace by default**).
2. **Bootstrapped browser approval fallback** — when the host has no usable
   native form, fall back to the bootstrapped browser approval page carrying
   the same request and the same two scope choices.
3. **Menubar pending-request recovery** — a request that is still pending
   (missed form, closed browser, host restart) remains listed as a pending
   switch request in the menubar, where the human can approve with either
   scope or decline it. The menubar never auto-approves.

The agent surfaces the pending state once and waits; it must not retry the
request, poll the target deck, or present its own scope picker.

## 3. Non-goals (explicitly out of scope)

- No generic security or authorization redesign (NOT-44 scoping,
  principals, and elevation for non-switch admin work are unchanged).
- No terminal yes/no prompt as an approval surface.
- No IDE reload / host restart as part of the switch path.
- No deck-specific playbook stub regeneration as part of the switch path.

## 4. Child-ticket map (informative)

| Ticket slice | Follows |
| --- | --- |
| Switch-request tool + pending/declined containment | 2.1, 2.2 |
| Approval surfaces in presentation order | 2.3 |
| Session-only vs. workspace-default commit | 2.1 |
| Anything in section 3 | Rejected as out of scope |

## 5. Acceptance reading

An engineer implementing a child ticket from this document alone can state:
the two commit scopes (**This session only** / **This workspace by default**),
the containment invariant (pending/declined changes nothing and exposes
nothing from the target deck), the fallback order (host-native MCP form →
bootstrapped browser approval → menubar pending-request recovery), and the
four non-goals in section 3.
