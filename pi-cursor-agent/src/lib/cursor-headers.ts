/**
 * Native cursor-agent sets x-cursor-timezone from Intl when absent.
 * Mirrors that helper so AgentService / AiService stay aligned.
 */
export function applyCursorTimezoneHeader(header: Headers): void {
  if (header.get("x-cursor-timezone") !== null) return;
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return;
  }
  if (timeZone !== undefined && timeZone.length > 0) {
    header.set("x-cursor-timezone", timeZone);
  }
}
