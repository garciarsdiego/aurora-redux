// Adapted from Runfusion/Fusion (MIT) — packages/engine/src/scheduler.ts @ 5f6d998cb2e94ac90f6c204911c82c08e2640e05

/**
 * Paths overlap if they are identical, or if one is a directory prefix of the other.
 * Glob patterns (ending with `/*`) are treated as directory prefixes.
 *
 * Exported for direct unit testing; used internally by the parallel scheduler.
 */
export function pathsOverlap(a: string[], b: string[]): boolean {
  for (const pa of a) {
    const prefixA = pa.endsWith("/*") ? pa.slice(0, -1) : null;
    for (const pb of b) {
      const prefixB = pb.endsWith("/*") ? pb.slice(0, -1) : null;

      // Exact match (ignoring glob suffix)
      const cleanA = prefixA ? pa.slice(0, -2) : pa;
      const cleanB = prefixB ? pb.slice(0, -2) : pb;
      if (cleanA === cleanB) return true;

      // Check prefix overlap
      if (prefixA && pb.startsWith(prefixA)) return true;
      if (prefixB && pa.startsWith(prefixB)) return true;
      if (prefixA && prefixB) {
        if (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA))
          return true;
      }

      // Exact file path match
      if (pa === pb) return true;
    }
  }
  return false;
}

function normalizeOverlapPath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function isIgnoredOverlapPath(path: string, ignorePath: string): boolean {
  const normalizedPath = normalizeOverlapPath(path);
  const normalizedIgnore = normalizeOverlapPath(ignorePath);

  if (normalizedIgnore.endsWith("/*")) {
    const directory = normalizedIgnore.slice(0, -2);
    return normalizedPath === directory || normalizedPath.startsWith(`${directory}/`);
  }

  if (normalizedIgnore.endsWith("/")) {
    const directory = normalizedIgnore.slice(0, -1);
    return normalizedPath === directory || normalizedPath.startsWith(normalizedIgnore);
  }

  return normalizedPath === normalizedIgnore || normalizedPath.startsWith(`${normalizedIgnore}/`);
}

/**
 * Remove scope entries that match configured overlap-ignore paths.
 * Used by scheduler overlap gating so shared safe paths (docs/generated/etc.)
 * can bypass serialization while keeping overlap protection enabled globally.
 */
export function filterPathsByIgnoreList(paths: string[], ignorePaths?: string[]): string[] {
  if (!ignorePaths || ignorePaths.length === 0) {
    return paths;
  }

  const normalizedIgnorePaths = ignorePaths.map(normalizeOverlapPath).filter(Boolean);
  if (normalizedIgnorePaths.length === 0) {
    return paths;
  }

  return paths.filter((path) => !normalizedIgnorePaths.some((ignore) => isIgnoredOverlapPath(path, ignore)));
}
