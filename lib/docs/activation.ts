import { DOCUMENT_ID } from "./server.ts";
import type { Json } from "./types.ts";

export function validateActivationReport(report: Json) {
  if (["automated", "both_editor_permissions", "actual_google_signins", "rendered_layout"].some(field => report[field] !== "passed") || report.original_id !== DOCUMENT_ID || typeof report.original_revision !== "string" || !report.original_revision || typeof report.connection_id !== "string" || !report.connection_id || typeof report.tested_at !== "string" || !Number.isFinite(Date.parse(report.tested_at))) {
    throw Error("Live temporary-document, Google login, layout and sharing checks must pass before activation.");
  }
}

export function validateActivationConnection(report: Json, connection: Json, currentRevision: string) {
  if (connection.id !== report.connection_id || connection.document_id !== DOCUMENT_ID || connection.enabled || !connection.inspected_at || connection.state !== "awaiting_test" || currentRevision !== report.original_revision) {
    throw Error("The connection or original document changed; repeat inspection and acceptance before activation.");
  }
}
