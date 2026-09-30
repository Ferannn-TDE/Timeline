import type { Plan } from "./types.ts";

export function recoveryDecision(current: { operation: string | null; revision: string }, intent: { id: string; expected_revision: string; applied_revision?: string | null; baseline_after: unknown; plan: Pick<Plan, "changed"> }): "commit" | "capture" | "retry" | "review" {
  if (!intent.plan.changed && intent.baseline_after !== null) return "commit";
  if (current.operation === intent.id) {
    if (intent.baseline_after !== null) return "commit";
    if (intent.applied_revision && current.revision === intent.applied_revision) return "capture";
    return "review"; // Never acknowledge potentially intervening direct edits.
  }
  return !intent.applied_revision && current.revision === intent.expected_revision ? "retry" : "review";
}
