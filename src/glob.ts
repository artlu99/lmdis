const hasGlobMeta = (s: string) => /[*?[\]\\]/.test(s);

/** Redis-style glob: * ? [class] and \\ escape. */
export const matchGlob = (pattern: string, text: string): boolean => {
  let pi = 0;
  let ti = 0;
  let starPi = -1;
  let starTi = -1;

  const matchClass = (start: number): [boolean, number] | null => {
    if (pattern[start] !== "[") return null;
    let i = start + 1;
    if (i >= pattern.length) return null;
    if (pattern[i] === "]") return null;
    const chars = new Set<string>();
    while (i < pattern.length && pattern[i] !== "]") {
      if (pattern[i] === "\\" && i + 1 < pattern.length) {
        chars.add(pattern[i + 1]!);
        i += 2;
        continue;
      }
      if (i + 2 < pattern.length && pattern[i + 1] === "-") {
        const from = pattern[i]!.charCodeAt(0);
        const to = pattern[i + 2]!.charCodeAt(0);
        for (let c = from; c <= to; c++) chars.add(String.fromCharCode(c));
        i += 3;
        continue;
      }
      chars.add(pattern[i]!);
      i++;
    }
    if (i >= pattern.length || pattern[i] !== "]") return null;
    return [chars.has(text[ti] ?? ""), i + 1];
  };

  while (ti < text.length) {
    if (pi < pattern.length) {
      const pc = pattern[pi]!;
      if (pc === "\\" && pi + 1 < pattern.length) {
        if (text[ti] === pattern[pi + 1]) {
          pi += 2;
          ti++;
          continue;
        }
        if (starPi >= 0) {
          pi = starPi + 1;
          starTi++;
          ti = starTi;
          continue;
        }
        return false;
      }
      if (pc === "[") {
        const matched = matchClass(pi);
        if (matched) {
          if (!matched[0]) {
            if (starPi >= 0) {
              pi = starPi + 1;
              starTi++;
              ti = starTi;
              continue;
            }
            return false;
          }
          pi = matched[1];
          ti++;
          continue;
        }
      }
      if (pc === "?" || pc === text[ti]) {
        pi++;
        ti++;
        continue;
      }
      if (pc === "*") {
        starPi = pi;
        starTi = ti;
        pi++;
        continue;
      }
    }
    if (starPi >= 0) {
      pi = starPi + 1;
      starTi++;
      ti = starTi;
      continue;
    }
    return false;
  }

  while (pi < pattern.length && pattern[pi] === "*") pi++;
  return pi === pattern.length;
};

/** literalPrefix* with no other glob metacharacters — enables index range scan. */
export const globIndexRange = (pattern: string): { prefix: string } | null => {
  if (!pattern.endsWith("*")) return null;
  const prefix = pattern.slice(0, -1);
  if (hasGlobMeta(prefix)) return null;
  return { prefix };
};
