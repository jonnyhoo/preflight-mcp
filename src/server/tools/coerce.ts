/**
 * Zod coercion helpers for MCP clients that serialize arrays/objects as JSON strings.
 */
import * as z from 'zod';

/** Wrap any zod schema to accept JSON string input from MCP clients. */
export function coerceJson<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (val) => {
      if (typeof val !== 'string') return val;
      try { return JSON.parse(val); } catch { return val; }
    },
    schema,
  );
}
