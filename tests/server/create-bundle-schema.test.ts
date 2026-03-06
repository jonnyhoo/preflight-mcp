import { describe, expect, it } from '@jest/globals';
import * as z from 'zod';

import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';

import {
  CreateBundleInputSchema,
  GetTaskStatusInputSchema,
  ListBundlesInputSchema,
} from '../../src/server/tools/bundle/types.js';

describe('preflight_create_bundle schema compatibility', () => {
  it('exposes repos items as a flat object schema', () => {
    const schema = toJsonSchemaCompat(normalizeObjectSchema(CreateBundleInputSchema)!, {
      strictUnions: true,
      pipeStrategy: 'input',
    }) as any;

    expect(schema.type).toBe('object');
    expect(schema.properties?.repos?.type).toBe('array');
    expect(schema.properties?.repos?.items?.type).toBe('object');
    expect(schema.properties?.repos?.items?.anyOf).toBeUndefined();
    expect(schema.properties?.repos?.items?.oneOf).toBeUndefined();
    expect(schema.properties?.repos?.items?.properties?.kind?.enum).toEqual(
      expect.arrayContaining(['github', 'local', 'web', 'pdf', 'markdown'])
    );
    expect(schema.properties?.repos?.items?.properties?.repo?.type).toBe('string');
    expect(schema.properties?.repos?.items?.properties?.path?.type).toBe('string');
    expect(schema.properties?.repos?.items?.properties?.url?.type).toBe('string');
  });

  it('still accepts stringified repos for MCP clients that JSON-serialize arrays', () => {
    const createSchema = z.object(CreateBundleInputSchema);
    const statusSchema = z.object(GetTaskStatusInputSchema);

    const createResult = createSchema.safeParse({
      repos: '[{"kind":"github","repo":"owner/repo"}]',
    });
    const statusResult = statusSchema.safeParse({
      repos: '[{"kind":"github","repo":"owner/repo"}]',
    });

    expect(createResult.success).toBe(true);
    expect(statusResult.success).toBe(true);
  });

  it('still coerces numeric string inputs in list schemas', () => {
    const listSchema = z.object(ListBundlesInputSchema);
    const result = listSchema.safeParse({
      limit: '10',
      maxItemsPerList: '5',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
      expect(result.data.maxItemsPerList).toBe(5);
    }
  });
});
