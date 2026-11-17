/**
 * Pi auto/manual compaction is cancelled while the active model is Cursor Agent.
 * Global auto-compact can stay enabled; after switching to another provider, Pi's
 * normal threshold check (context vs that model's window) runs as usual.
 */
export function shouldCancelCompactionForModel(
  model: { provider?: string } | undefined | null,
): boolean {
  return model?.provider === "cursor-agent";
}
