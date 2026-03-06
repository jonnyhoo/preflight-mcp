import { describe, expect, it } from '@jest/globals';

import { normalizeObjectSchema } from '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js';
import { toJsonSchemaCompat } from '../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js';

import { CreateBundleInputSchema } from '../../src/server/tools/bundle/types.js';

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
});
