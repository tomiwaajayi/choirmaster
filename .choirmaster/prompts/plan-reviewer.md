# Plan reviewer agent (placeholder)

> The plan-reviewer role is not yet wired into the runtime; this file
> exists so the manifest's `prompts.planReviewer` path resolves and so
> Phase 2B (plan-review iteration) can land without a follow-up edit.
> Phase 2A's planner is single-shot.

When the plan reviewer ships, this prompt will instruct it to:

1. Read the planner's emitted task list and the source markdown plan.
2. Check task scope, dependencies, definitions of done, and risk.
3. Reject tasks that are too broad, ambiguous, or unsafe to execute.
4. Prefer tightening scope and splitting tasks over rewriting the plan.

Until then you can leave this file untouched.
