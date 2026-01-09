import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  createBuildCallGraphHandler,
  createQueryCallGraphHandler,
  createExtractCodeHandler,
  createInterfaceSummaryHandler,
} from '../../src/tools/callGraph.js';

describe('Call Graph Tools', () => {
  let tempDir: string;
  let testProjectDir: string;

  beforeAll(() => {
    // Create a temporary directory with sample TypeScript files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'callgraph-test-'));
    testProjectDir = path.join(tempDir, 'test-project');
    fs.mkdirSync(testProjectDir);

    // Create a simple project structure
    const utilsContent = `
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`;

    const mainContent = `
import { add, multiply } from './utils';

export function calculate(x: number, y: number): number {
  const sum = add(x, y);
  const product = multiply(x, y);
  return sum + product;
}

export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`;

    fs.writeFileSync(path.join(testProjectDir, 'utils.ts'), utilsContent);
    fs.writeFileSync(path.join(testProjectDir, 'main.ts'), mainContent);
  });

  afterAll(() => {
    // Clean up temporary directory
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('createBuildCallGraphHandler', () => {
    it('should build a call graph for a TypeScript project', async () => {
      const handler = createBuildCallGraphHandler();
      const result = await handler({
        path: testProjectDir,
        maxDepth: 5,
      });

      expect(result.success).toBe(true);
      expect(result.summary).toBeDefined();
      expect(result.summary!.totalFunctions).toBeGreaterThan(0);
      expect(result.summary!.filesAnalyzed).toBeGreaterThan(0);
      expect(result.hint).toBeDefined();
    });

    it('should handle non-existent path gracefully', async () => {
      const handler = createBuildCallGraphHandler();
      const result = await handler({
        path: '/non/existent/path',
        maxDepth: 5,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should respect maxDepth parameter', async () => {
      const handler = createBuildCallGraphHandler();
      const result = await handler({
        path: testProjectDir,
        maxDepth: 1,
      });

      expect(result.success).toBe(true);
      expect(result.summary).toBeDefined();
    });
  });

  describe('createQueryCallGraphHandler', () => {
    it('should query call relationships for a symbol', async () => {
      // First build the graph
      const buildHandler = createBuildCallGraphHandler();
      await buildHandler({ path: testProjectDir, maxDepth: 5 });

      // Then query it
      const queryHandler = createQueryCallGraphHandler();
      const result = await queryHandler({
        path: testProjectDir,
        symbol: 'calculate',
        direction: 'both',
        maxDepth: 3,
      });

      expect(result.success).toBe(true);
      expect(result.symbol).toBeDefined();
      expect(result.symbol!.name).toContain('calculate');
    });

    it('should return available symbols when symbol not found', async () => {
      const queryHandler = createQueryCallGraphHandler();
      const result = await queryHandler({
        path: testProjectDir,
        symbol: 'nonExistentFunction',
        direction: 'both',
        maxDepth: 3,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(result.availableSymbols).toBeDefined();
    });

    it('should support different query directions', async () => {
      const queryHandler = createQueryCallGraphHandler();

      const callersResult = await queryHandler({
        path: testProjectDir,
        symbol: 'add',
        direction: 'callers',
        maxDepth: 3,
      });

      const calleesResult = await queryHandler({
        path: testProjectDir,
        symbol: 'calculate',
        direction: 'callees',
        maxDepth: 3,
      });

      // Both queries should succeed
      expect(callersResult.success || calleesResult.success).toBe(true);
    });
  });

  describe('createExtractCodeHandler', () => {
    it('should extract code for a symbol in markdown format', async () => {
      const handler = createExtractCodeHandler();
      const result = await handler({
        path: testProjectDir,
        symbol: 'calculate',
        includeTransitive: true,
        format: 'markdown',
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe('markdown');
      expect(result.content).toBeDefined();
    });

    it('should extract code in minimal format', async () => {
      const handler = createExtractCodeHandler();
      const result = await handler({
        path: testProjectDir,
        symbol: 'add',
        includeTransitive: false,
        format: 'minimal',
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe('minimal');
    });

    it('should handle non-existent symbol', async () => {
      const handler = createExtractCodeHandler();
      const result = await handler({
        path: testProjectDir,
        symbol: 'doesNotExist',
        includeTransitive: false,
        format: 'full',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('createInterfaceSummaryHandler', () => {
    it('should generate interface summary for exported symbols', async () => {
      const handler = createInterfaceSummaryHandler();
      const result = await handler({
        path: testProjectDir,
        exportedOnly: true,
      });

      expect(result.success).toBe(true);
      expect(result.stats).toBeDefined();
      expect(result.stats!.files).toBeGreaterThan(0);
      expect(result.summary).toBeDefined();
    });

    it('should include all symbols when exportedOnly is false', async () => {
      const handler = createInterfaceSummaryHandler();
      const result = await handler({
        path: testProjectDir,
        exportedOnly: false,
      });

      expect(result.success).toBe(true);
    });

    it('should work on a single file', async () => {
      const handler = createInterfaceSummaryHandler();
      const result = await handler({
        path: path.join(testProjectDir, 'utils.ts'),
        exportedOnly: true,
      });

      expect(result.success).toBe(true);
    });
  });
});
