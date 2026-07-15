/**
 * Convert a glob pattern to a RegExp. Supports:
 *   `*`  — any run of characters except `/`
 *   `**` — any run of characters including `/` (and an optional trailing `/`)
 *   `?`  — a single character except `/`
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/**
 * Compile a set of ignore globs into a predicate over repo-relative paths.
 * A pattern with no `/` also matches against the basename, so `*.lock` hides
 * lock files in any directory.
 */
export function compileIgnore(patterns: string[]): (relativePath: string) => boolean {
  const matchers = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ re: globToRegExp(p), basenameOnly: !p.includes("/") }));

  if (matchers.length === 0) {
    return () => false;
  }

  return (relativePath: string) => {
    const normalized = relativePath.replace(/\\/g, "/");
    const base = normalized.split("/").pop() ?? normalized;
    return matchers.some(
      (m) => m.re.test(normalized) || (m.basenameOnly && m.re.test(base))
    );
  };
}
