# ADR 0003: Why the agent cannot act without human approval

**Status:** accepted

## Context
The agent reads public notice text, which is untrusted and may contain instructions aimed at an LLM. Its proposals can change opportunities, schedules and assignments for a company. Tenderline also must not give legal or procurement advice: the agent proposes, a human decides.

## Decision
1. The agent has **no execution path**. It writes `agent_proposals` rows (status `pending`) and nothing else. Its output is parsed into strict Pydantic models (`extra="forbid"`); an unknown action type, extra field, bad payload or extra top-level key invalidates the whole response, which is recorded in `llm_calls` as `invalid` and creates nothing.
2. Only five typed tools exist: `create_opportunity`, `add_deadline_reminders`, `assign_reviewer`, `draft_clarification_question` (a draft stored on the opportunity; Tenderline never contacts buyers), `mark_no_bid`.
3. Execution happens only after a human approves (roles owner, bid_manager, reviewer). Server-side authority is re-applied after the model answers: duplicate actions are dropped, and `assign_reviewer` is kept only for a user who is a reviewer-capable member of that organisation.
4. A proposal is tied to a notice version. A corrigendum cancels pending proposals; approving a stale or cancelled proposal returns 409, including in the race window before the cancellation workflow has run.
5. Execution is exactly-once: the tool and the `executed` status commit in one transaction under a row lock, and the workflow id is the proposal id. A reconciler restarts approvals whose start was lost to a crash.
6. Notice text is placed only inside a delimited data block in the user prompt, with `<` and `>` escaped so it cannot close the block; the system prompt says to treat it as data. This is defence in depth: the structural controls above, not the prompt, are what make injection harmless. Tests show that hostile text neither changes the (fake) agent's output or schema nor produces an unlisted action, and that a deliberately compromised provider creates no proposals.

## Added after the audit
- **One qualification per notice.** Proposals are unique per organisation, notice version and action (a partial unique index on pending rows). Several saved searches matching one notice, or two workers racing, cannot create duplicates.
- **The model never sees who the members are.** Reviewers appear in the prompt as opaque labels (`reviewer-1`). The server maps a label back to a member and drops any label it did not hand out. A user id in the model's answer fails validation, which rules out a notice planting another tenant's id.
- **Cached answers are re-checked.** The model's raw answer is cached; the server-side checks run on every use, so a member who has left cannot be proposed from a stale cache entry.
- **No silent fallback in production.** With `ENV=prod`, a provider chain with no usable credentials stops the app from qualifying instead of quietly using the offline heuristic.
- **Awards.** A win is recorded only on an exact normalised-name match with a listed winner. Anything else is closed as lost and flagged `outcome_needs_review` for a person to confirm.

This follows the action-selector pattern in Beurer-Kellner et al., "Design Patterns for Securing LLM Agents against Prompt Injections" (2025): the model can only choose among fixed, typed actions and nothing it reads can make an action run.

## Consequences
Every action has a human actor in the audit log (`proposal.approved`, `proposal.executed`); agent-authored rows are marked `actor_type=agent`. The cost is one approval step per action, which is the intended product behaviour.
