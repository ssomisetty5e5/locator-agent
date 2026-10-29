// ============================================================
// Locator expression parser
// Parses the Playwright (TypeScript) expressions the generators emit, e.g.
//   page.frameLocator("iframe#a").locator('tr').filter({ hasText: 'x' }).getByRole('button', { name: 'Go' })
// into a list of calls, so they can be re-rendered for other languages.
// Only the small grammar the generators produce is supported; anything
// else returns null rather than guessing.
// ============================================================

/** A call argument: a string, or an object of string values (e.g. `{ name: 'Go' }`). */
export type CallArg = string | Record<string, string>;

export interface CallStep {
  method: string;
  args: CallArg[];
}

/** Parse `page.<call>(...)(.<call>(...))*`. Returns null when the text isn't in that form. */
export function parseExpression(expression: string): CallStep[] | null {
  const src = expression.trim();
  if (!src.startsWith('page.')) return null;

  let pos = 'page.'.length;
  const steps: CallStep[] = [];

  const skipWs = () => { while (pos < src.length && /\s/.test(src[pos])) pos++; };

  const readIdent = (): string | null => {
    const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(pos));
    if (!m) return null;
    pos += m[0].length;
    return m[0];
  };

  const readString = (): string | null => {
    const quote = src[pos];
    if (quote !== "'" && quote !== '"') return null;
    pos++;
    let out = '';
    while (pos < src.length) {
      const ch = src[pos++];
      if (ch === quote) return out;
      if (ch === '\\') {
        const next = src[pos++];
        if (next === undefined) return null;
        out += next === 'n' ? '\n' : next;
      } else {
        out += ch;
      }
    }
    return null; // unterminated
  };

  const readObject = (): Record<string, string> | null => {
    if (src[pos] !== '{') return null;
    pos++;
    const obj: Record<string, string> = {};
    skipWs();
    while (src[pos] !== '}') {
      const key = readIdent();
      if (!key) return null;
      skipWs();
      if (src[pos++] !== ':') return null;
      skipWs();
      const value = readString();
      if (value === null) return null;
      obj[key] = value;
      skipWs();
      if (src[pos] === ',') { pos++; skipWs(); }
      else if (src[pos] !== '}') return null;
    }
    pos++; // }
    return obj;
  };

  while (pos < src.length) {
    const method = readIdent();
    if (!method) return null;
    if (src[pos++] !== '(') return null;

    const args: CallArg[] = [];
    skipWs();
    while (src[pos] !== ')') {
      const arg = src[pos] === '{' ? readObject() : readString();
      if (arg === null) return null;
      args.push(arg);
      skipWs();
      if (src[pos] === ',') { pos++; skipWs(); }
      else if (src[pos] !== ')') return null;
    }
    pos++; // )
    steps.push({ method, args });

    if (pos >= src.length) break;
    if (src[pos++] !== '.') return null;
  }

  return steps.length > 0 ? steps : null;
}
