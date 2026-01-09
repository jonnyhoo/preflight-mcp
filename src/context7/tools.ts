export type ToolCallResultLike = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
  // Some SDK compatibility modes return a different shape.
  toolResult?: unknown;
};

export function textFromToolResult(res: ToolCallResultLike): string {
  const content = 'content' in res ? res.content : undefined;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const c of content) {
    if (c && c.type === 'text' && typeof c.text === 'string') {
      parts.push(c.text);
    }
  }
  return parts.join('\n');
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (!value || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return;
  }

  for (const v of Object.values(value as Record<string, unknown>)) {
    collectStrings(v, out);
  }
}

export function extractContext7IdsFromResult(res: ToolCallResultLike): string[] {
  const candidates: string[] = [];

  if (res.structuredContent) {
    collectStrings(res.structuredContent, candidates);
  }

  const text = textFromToolResult(res);
  if (text) {
    // Match strings like /owner/repo, /scope/pkg, etc.
    const re = /\/[A-Za-z0-9@._-]+(?:\/[A-Za-z0-9@._-]+)+/g;
    for (const m of text.matchAll(re)) {
      if (m[0]) candidates.push(m[0]);
    }
  }

  // Normalize + de-dupe, keep order.
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of candidates) {
    const s = raw.trim();
    if (!s.startsWith('/')) continue;
    if (!s.includes('/')) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    ids.push(s);
  }
  return ids;
}
