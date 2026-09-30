// A changed file without our operation marker is ambiguous. Never resolve an
// uncertain external write by automatically replacing the latest document.
export function recoveryAction(current: { operation: string | null; hash: string; etag: string }, intent: { id: string; output_hash: string; expected_etag: string }): "commit" | "retry" | "review" {
  if (current.operation === intent.id || current.hash === intent.output_hash) return "commit";
  return current.etag === intent.expected_etag ? "retry" : "review";
}
