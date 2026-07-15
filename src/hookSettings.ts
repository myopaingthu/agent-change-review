/**
 * Pure helpers for merging Agent Change Review's hook entries into a Claude Code
 * settings object. Kept free of `vscode` so it can be unit-tested headlessly.
 */

export interface HookCommand {
  type: string;
  command: string;
}
export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
export interface HookSettings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

export const EVENT_ARGS: Array<{ event: string; arg: string; matcher?: string }> = [
  { event: "UserPromptSubmit", arg: "prompt" },
  { event: "PostToolUse", arg: "tool", matcher: "Edit|Write|MultiEdit|NotebookEdit" },
  { event: "Stop", arg: "stop" },
];

export function commandFor(hookPath: string, arg: string): string {
  return `node "${hookPath}" ${arg}`;
}

/** Replace any prior ACR groups with fresh ones, leaving other hooks intact. */
export function applyOurGroups(
  hooks: Record<string, HookGroup[]>,
  hookPath: string
): void {
  removeOurGroups(hooks, hookPath);
  for (const { event, arg, matcher } of EVENT_ARGS) {
    const group: HookGroup = {
      hooks: [{ type: "command", command: commandFor(hookPath, arg) }],
    };
    if (matcher) {
      group.matcher = matcher;
    }
    hooks[event] = hooks[event] ?? [];
    hooks[event].push(group);
  }
}

/** Remove only the groups whose commands reference our hook runner. */
export function removeOurGroups(
  hooks: Record<string, HookGroup[]>,
  hookPath: string
): void {
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event].filter(
      (g) =>
        !g.hooks?.some(
          (h) => typeof h.command === "string" && h.command.includes(hookPath)
        )
    );
    if (groups.length) {
      hooks[event] = groups;
    } else {
      delete hooks[event];
    }
  }
}
