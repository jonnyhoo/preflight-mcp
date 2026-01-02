/**
 * RFC v2.1: preflight_suggest_traces - Auto-discover trace relationships.
 * 
 * Analyzes bundle files to suggest traceability links based on:
 * - Naming conventions (foo.ts <-> foo.test.ts, foo.spec.ts)
 * - Import analysis (test imports source)
 * - Directory structure (tests/ mirrors src/)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';

import { type PreflightConfig } from '../config.js';
import { findBundleStorageDir, getBundlePathsForId } from '../bundle/service.js';
import { type TraceEdgeInput, type TraceEntityRef } from './store.js';

/**
 * Test file naming patterns (from deep.ts)
 */
const TEST_FILE_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/i,   // *.test.ts, *.test.js
  /\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/i,   // *.spec.ts, *.spec.js
  /_test\.(py|go)$/i,                     // *_test.py, *_test.go
  /^test_.*\.py$/i,                       // test_*.py (pytest convention)
  /_test\.rs$/i,                          // *_test.rs (Rust)
];

/**
 * Source file extensions to consider
 */
const SOURCE_FILE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs',
];

/**
 * Input schema for preflight_suggest_traces
 */
export const SuggestTracesInputSchema = {
  bundleId: z.string().describe('Bundle ID to analyze.'),
  edge_type: z
    .enum(['tested_by', 'documents', 'implements'])
    .default('tested_by')
    .describe('Type of trace edges to suggest. Default: tested_by.'),
  scope: z
    .enum(['repo', 'bundle'])
    .default('repo')
    .describe('Scope of analysis. repo=single repo (default), bundle=all repos in bundle.'),
  confidenceThreshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe('Minimum confidence to include in suggestions. Default: 0.5.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Maximum number of suggestions to return. Default: 50.'),
  dryRun: z
    .boolean()
    .default(true)
    .describe('If true (default), only return suggestions. If false, auto-upsert suggestions.'),
};

export type SuggestTracesInput = z.infer<z.ZodObject<typeof SuggestTracesInputSchema>>;

/**
 * A suggested trace edge with reasoning
 */
export type SuggestedTraceEdge = TraceEdgeInput & {
  reason: string;
  matchType: 'naming' | 'import' | 'directory' | 'heuristic';
};

/**
 * Result of suggest traces operation
 */
export type SuggestTracesResult = {
  bundleId: string;
  edge_type: string;
  scope: string;
  suggestions: SuggestedTraceEdge[];
  stats: {
    totalTestFiles: number;
    totalSourceFiles: number;
    matchedPairs: number;
    avgConfidence: number;
  };
  hint: string;
  nextSteps: string[];
};

/**
 * File info for matching
 */
type FileInfo = {
  path: string;           // Full bundle-relative path
  name: string;           // File name only
  baseName: string;       // Name without extension(s)
  extension: string;      // Extension including dot
  isTest: boolean;
  directory: string;      // Parent directory
};

/**
 * Extract base name from a file path, stripping test suffixes
 */
function extractBaseName(fileName: string): string {
  // Remove common test suffixes and extensions
  let base = fileName;
  
  // Remove all extensions
  const extMatch = base.match(/^(.+?)(?:\.test|\.spec|_test|\.tests?)?\.[^.]+$/i);
  if (extMatch) {
    base = extMatch[1] ?? base;
  }
  
  // Remove leading test_ prefix (Python convention)
  if (base.toLowerCase().startsWith('test_')) {
    base = base.slice(5);
  }
  
  return base;
}

/**
 * Check if a file is a test file
 */
function isTestFile(fileName: string): boolean {
  return TEST_FILE_PATTERNS.some(pattern => pattern.test(fileName));
}

/**
 * Check if a file is a source file (not test, not config)
 */
function isSourceFile(fileName: string): boolean {
  if (isTestFile(fileName)) return false;
  
  const ext = path.extname(fileName).toLowerCase();
  if (!SOURCE_FILE_EXTENSIONS.includes(ext)) return false;
  
  // Skip config files
  const configPatterns = [
    /\.config\./i,
    /\.conf\./i,
    /^config\./i,
    /^\..*rc\./i,
    /setup\.py$/i,
    /conftest\.py$/i,
  ];
  
  if (configPatterns.some(p => p.test(fileName))) return false;
  
  return true;
}

/**
 * Walk directory and collect file info
 */
async function collectFiles(bundleRoot: string): Promise<FileInfo[]> {
  const files: FileInfo[] = [];
  
  async function walk(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(bundleRoot, fullPath).replace(/\\/g, '/');
        
        // Skip hidden directories and common non-source directories
        if (entry.isDirectory()) {
          const skipDirs = ['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv'];
          if (!entry.name.startsWith('.') && !skipDirs.includes(entry.name)) {
            await walk(fullPath);
          }
          continue;
        }
        
        if (!entry.isFile()) continue;
        
        const fileName = entry.name;
        const ext = path.extname(fileName);
        
        files.push({
          path: relativePath,
          name: fileName,
          baseName: extractBaseName(fileName),
          extension: ext,
          isTest: isTestFile(fileName),
          directory: path.dirname(relativePath),
        });
      }
    } catch {
      // Ignore permission errors
    }
  }
  
  await walk(bundleRoot);
  return files;
}

/**
 * Match test files with source files based on naming conventions
 */
function matchByNaming(
  testFiles: FileInfo[],
  sourceFiles: FileInfo[],
  confidenceThreshold: number
): SuggestedTraceEdge[] {
  const suggestions: SuggestedTraceEdge[] = [];
  
  // Build source file index by base name
  const sourceByBaseName = new Map<string, FileInfo[]>();
  for (const src of sourceFiles) {
    const key = src.baseName.toLowerCase();
    if (!sourceByBaseName.has(key)) {
      sourceByBaseName.set(key, []);
    }
    sourceByBaseName.get(key)!.push(src);
  }
  
  for (const test of testFiles) {
    const testBase = test.baseName.toLowerCase();
    const candidates = sourceByBaseName.get(testBase);
    
    if (!candidates || candidates.length === 0) continue;
    
    // Find best match considering directory proximity
    let bestMatch: FileInfo | null = null;
    let bestConfidence = 0;
    let matchReason = '';
    
    for (const src of candidates) {
      let confidence = 0.7; // Base confidence for name match
      let reason = `Name match: ${src.baseName} ↔ ${test.baseName}`;
      
      // Boost confidence if in same directory or parallel test/src structure
      if (src.directory === test.directory) {
        confidence = 0.9;
        reason = `Same directory: ${src.path} ↔ ${test.path}`;
      } else if (
        test.directory.includes('/tests/') && 
        src.directory.includes('/src/') &&
        test.directory.replace('/tests/', '/src/') === src.directory
      ) {
        confidence = 0.85;
        reason = `Parallel structure: src/ ↔ tests/`;
      } else if (
        test.directory.includes('/__tests__/') && 
        test.directory.replace('/__tests__', '') === src.directory
      ) {
        confidence = 0.85;
        reason = `Jest __tests__ convention`;
      }
      
      // Boost if extensions match language
      const testExt = test.extension.toLowerCase();
      const srcExt = src.extension.toLowerCase();
      if (testExt === srcExt || 
          (testExt === '.tsx' && srcExt === '.ts') ||
          (testExt === '.jsx' && srcExt === '.js')) {
        confidence += 0.05;
      }
      
      if (confidence > bestConfidence) {
        bestConfidence = confidence;
        bestMatch = src;
        matchReason = reason;
      }
    }
    
    if (bestMatch && bestConfidence >= confidenceThreshold) {
      suggestions.push({
        source: { type: 'file', id: bestMatch.path },
        target: { type: 'file', id: test.path },
        type: 'tested_by',
        confidence: Math.round(bestConfidence * 100) / 100,
        method: 'heuristic',
        sources: [{
          note: matchReason,
        }],
        reason: matchReason,
        matchType: 'naming',
      });
    }
  }
  
  return suggestions;
}

/**
 * Match test files with source files based on directory structure
 */
function matchByDirectory(
  testFiles: FileInfo[],
  sourceFiles: FileInfo[],
  confidenceThreshold: number
): SuggestedTraceEdge[] {
  const suggestions: SuggestedTraceEdge[] = [];
  
  // Group test files by directory
  const testsByDir = new Map<string, FileInfo[]>();
  for (const test of testFiles) {
    const dir = test.directory;
    if (!testsByDir.has(dir)) {
      testsByDir.set(dir, []);
    }
    testsByDir.get(dir)!.push(test);
  }
  
  // Group source files by directory
  const sourcesByDir = new Map<string, FileInfo[]>();
  for (const src of sourceFiles) {
    const dir = src.directory;
    if (!sourcesByDir.has(dir)) {
      sourcesByDir.set(dir, []);
    }
    sourcesByDir.get(dir)!.push(src);
  }
  
  // Match test directories to source directories
  for (const [testDir, tests] of testsByDir) {
    // Try to find corresponding source directory
    let srcDir: string | null = null;
    let confidence = 0.6;
    
    // Pattern: tests/foo -> src/foo
    if (testDir.includes('/tests/')) {
      srcDir = testDir.replace('/tests/', '/src/');
    }
    // Pattern: test/foo -> src/foo
    else if (testDir.includes('/test/')) {
      srcDir = testDir.replace('/test/', '/src/');
    }
    // Pattern: __tests__ -> parent
    else if (testDir.includes('/__tests__')) {
      srcDir = testDir.replace('/__tests__', '');
      confidence = 0.5;
    }
    
    if (!srcDir) continue;
    
    const sources = sourcesByDir.get(srcDir);
    if (!sources || sources.length === 0) continue;
    
    if (confidence < confidenceThreshold) continue;
    
    // Create directory-level trace suggestion
    for (const test of tests) {
      // Find a representative source file
      const srcFile = sources[0]!;
      suggestions.push({
        source: { type: 'file', id: srcFile.path },
        target: { type: 'file', id: test.path },
        type: 'tested_by',
        confidence,
        method: 'heuristic',
        sources: [{
          note: `Directory structure match: ${srcDir} ↔ ${testDir}`,
        }],
        reason: `Directory structure: ${srcDir} → ${testDir}`,
        matchType: 'directory',
      });
    }
  }
  
  return suggestions;
}

/**
 * Main suggest traces function
 */
export async function suggestTraces(
  cfg: PreflightConfig,
  args: SuggestTracesInput
): Promise<SuggestTracesResult> {
  const storageDir = await findBundleStorageDir(cfg.storageDirs, args.bundleId);
  if (!storageDir) {
    throw new Error(`Bundle not found: ${args.bundleId}`);
  }
  
  const paths = getBundlePathsForId(storageDir, args.bundleId);
  const bundleRoot = paths.rootDir;
  
  // Collect all files
  const allFiles = await collectFiles(bundleRoot);
  
  // Separate test and source files
  const testFiles = allFiles.filter(f => f.isTest);
  const sourceFiles = allFiles.filter(f => isSourceFile(f.name) && !f.isTest);
  
  // Collect suggestions based on edge type
  let suggestions: SuggestedTraceEdge[] = [];
  
  if (args.edge_type === 'tested_by') {
    // Match by naming conventions first (higher confidence)
    const namingMatches = matchByNaming(testFiles, sourceFiles, args.confidenceThreshold);
    suggestions.push(...namingMatches);
    
    // Match by directory structure (lower confidence)
    const dirMatches = matchByDirectory(testFiles, sourceFiles, args.confidenceThreshold);
    
    // Only add directory matches for files not already matched
    const matchedTests = new Set(suggestions.map(s => s.target.id));
    for (const match of dirMatches) {
      if (!matchedTests.has(match.target.id)) {
        suggestions.push(match);
      }
    }
  }
  
  // Sort by confidence descending
  suggestions.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  
  // Apply limit
  suggestions = suggestions.slice(0, args.limit);
  
  // Calculate stats
  const avgConfidence = suggestions.length > 0
    ? suggestions.reduce((sum, s) => sum + (s.confidence ?? 0), 0) / suggestions.length
    : 0;
  
  // Generate hint
  let hint: string;
  if (suggestions.length === 0) {
    if (testFiles.length === 0) {
      hint = 'No test files detected. Consider adding tests with naming patterns like *.test.ts, *.spec.ts, *_test.py.';
    } else if (sourceFiles.length === 0) {
      hint = 'No source files detected. Bundle may only contain tests or config files.';
    } else {
      hint = `Found ${testFiles.length} test files and ${sourceFiles.length} source files, but no matches above confidence threshold ${args.confidenceThreshold}. Try lowering the threshold.`;
    }
  } else {
    hint = `Found ${suggestions.length} potential test↔code relationships with average confidence ${(avgConfidence * 100).toFixed(0)}%.`;
  }
  
  // Generate next steps
  const nextSteps: string[] = [];
  if (suggestions.length > 0) {
    nextSteps.push(
      `Review suggestions and use preflight_trace_upsert with dryRun=false to persist approved links.`,
      `Example: { bundleId: "${args.bundleId}", dryRun: false, edges: [<selected edges from suggestions>] }`
    );
  }
  if (testFiles.length === 0) {
    nextSteps.push('Consider adding tests to improve code coverage tracking.');
  }
  if (args.edge_type === 'tested_by') {
    nextSteps.push('Try edge_type="documents" to find documentation relationships.');
  }
  
  return {
    bundleId: args.bundleId,
    edge_type: args.edge_type,
    scope: args.scope,
    suggestions,
    stats: {
      totalTestFiles: testFiles.length,
      totalSourceFiles: sourceFiles.length,
      matchedPairs: suggestions.length,
      avgConfidence: Math.round(avgConfidence * 100) / 100,
    },
    hint,
    nextSteps,
  };
}

/**
 * Tool description for MCP registration
 */
export const suggestTracesToolDescription = {
  title: 'Suggest trace links (auto-discovery)',
  description:
    'Auto-discover potential traceability links between source and test files. ' +
    'Analyzes naming conventions (foo.ts ↔ foo.test.ts) and directory structure (src/ ↔ tests/). ' +
    '⚠️ SAFETY: Returns suggestions only by default (dryRun=true). ' +
    'Review suggestions before persisting with preflight_trace_upsert.\\n\\n' +
    '**Discovery methods:**\\n' +
    '- Naming: foo.ts ↔ foo.test.ts, foo.spec.ts\\n' +
    '- Directory: src/module/ ↔ tests/module/\\n' +
    '- Jest convention: src/foo.ts ↔ src/__tests__/foo.test.ts\\n\\n' +
    '**Usage:**\\n' +
    '1. Run preflight_suggest_traces to discover relationships\\n' +
    '2. Review suggestions and confidence scores\\n' +
    '3. Use preflight_trace_upsert with selected edges to persist\\n\\n' +
    'Triggers: "suggest traces", "discover tests", "auto trace", "find test relationships"',
};
