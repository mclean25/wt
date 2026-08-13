/**
 * Flat barrel for the Claude prompt-injection transport (see
 * `inject/transport.ts` for what it is and why). Importers use this
 * path; only the names re-exported here are public.
 */
export {
  claudeInjectSelftest,
  clearInspectorSocket,
  createClaudeInjector,
  deliverClaudeMessage,
  ensureInspectorDir,
  inspectorDir,
  inspectorEnabled,
  inspectorSocketExists,
  inspectorSocketPath,
  reapInspectorSockets,
  type InjectFailureKind,
  type InjectOutcome,
  type SelftestOutcome,
} from "./inject/transport.ts";
export { ensureInspectShims, pathWithShims, shimDir } from "./inject/shims.ts";
