/**
 * Pure helpers for merging Agent Change Review's hook entries into a Claude Code
 * settings object. Kept free of `vscode` so it can be unit-tested headlessly.
 *
 * Entries are `http` hooks pointing at the extension's loopback receiver, so
 * Claude Code posts the event itself and nothing has to be spawned. Removal
 * still recognises the older `command` entries that shelled out to Node, so an
 * upgrade replaces them rather than leaving both installed.
 */

export interface HookCommand {
  type: string;
  /** Set on legacy command entries only. */
  command?: string;
  /** Set on http entries: the loopback receiver's URL for one event. */
  url?: string;
  timeout?: number;
}
export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
export interface HookSettings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

const EDIT_TOOLS = "Edit|Write|MultiEdit|NotebookEdit";

/** Distinctive enough that it cannot collide with an unrelated user hook. */
const URL_MARKER = "/agent-change-review/";
/** Where the pre-0.4 command entries pointed; matched so upgrades replace them. */
const LEGACY_MARKER = "/.claude/acr/";

/** Claude Code lowers the command/http default to 30s for UserPromptSubmit. */
const TIMEOUT_SECONDS = 30;

export const HOOK_EVENTS: Array<{ event: string; slug: string; matcher?: string }> = [
  { event: "UserPromptSubmit", slug: "prompt" },
  // PreToolUse captures each repo's baseline *before* the agent edits it.
  { event: "PreToolUse", slug: "pre", matcher: EDIT_TOOLS },
  { event: "PostToolUse", slug: "tool", matcher: EDIT_TOOLS },
  { event: "Stop", slug: "stop" },
];

export function hookUrl(baseUrl: string, slug: string): string {
  return `${baseUrl}/${slug}`;
}

/** Replace any prior ACR groups with fresh ones, leaving other hooks intact. */
export function applyOurGroups(
  hooks: Record<string, HookGroup[]>,
  baseUrl: string
): void {
  removeOurGroups(hooks);
  for (const { event, slug, matcher } of HOOK_EVENTS) {
    const group: HookGroup = {
      hooks: [{ type: "http", url: hookUrl(baseUrl, slug), timeout: TIMEOUT_SECONDS }],
    };
    if (matcher) {
      group.matcher = matcher;
    }
    hooks[event] = hooks[event] ?? [];
    hooks[event].push(group);
  }
}

/** Remove only the groups that belong to this extension, current or legacy. */
export function removeOurGroups(hooks: Record<string, HookGroup[]>): void {
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event].filter((g) => !g.hooks?.some(isOurs));
    if (groups.length) {
      hooks[event] = groups;
    } else {
      delete hooks[event];
    }
  }
}

/** Whether the settings already hold exactly the entries `baseUrl` would produce. */
export function matchesOurGroups(
  hooks: Record<string, HookGroup[]> | undefined,
  baseUrl: string
): boolean {
  if (!hooks) {
    return false;
  }
  return HOOK_EVENTS.every(({ event, slug, matcher }) =>
    hooks[event]?.some(
      (g) =>
        g.matcher === matcher &&
        g.hooks?.some((h) => h.type === "http" && h.url === hookUrl(baseUrl, slug))
    )
  );
}

/** Whether any of this extension's entries are present, at any version. */
export function hasOurGroups(hooks: Record<string, HookGroup[]> | undefined): boolean {
  if (!hooks) {
    return false;
  }
  return Object.values(hooks).some((groups) => groups.some((g) => g.hooks?.some(isOurs)));
}

function isOurs(hook: HookCommand): boolean {
  if (typeof hook.url === "string" && hook.url.includes(URL_MARKER)) {
    return true;
  }
  if (typeof hook.command === "string") {
    return hook.command.replace(/\\/g, "/").includes(LEGACY_MARKER);
  }
  return false;
}
