/**
 * Trace suggestion engine for EDDA.
 * Automatically suggests trace links (e.g., tested_by) based on file patterns.
 * MVP: Only implements tested_by edge type.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { type EvidenceRef, type EvidenceMethod } from '../types/evidence.js';

export type SuggestEdgeType = 'tested_by';

export type TraceSuggestion = {
  type: SuggestEdgeType;
  source: { type: 'file'; id: string };
  target: { type: 'file'; id: string };
  confidence: number;
  method: EvidenceMethod;
  why: string;
  evidence: EvidenceRef[];
  /** Ready-to-use payload for trace_upsert */
  upsertPayload: {
    bundleId: string;
    dryRun: boolean;
    edges: Array<{
      type: string;
      confidence: number;
      method: EvidenceMethod;
      source: { type: string; id: string };
      target: { type: string; id: string };
      sources: Array<{ file: string; note: string }>;
    }>;
  };
};

export type SuggestTracesInput = {
  bundleId: string;
  edgeType: SuggestEdgeType;
  scope: 'repo' | 'dir' | 'file';
  scopePath?: string;
  minConfidence: number;
  limit: number;
  skipExisting: boolean;
  existingEdges?: Set<string>; // "source|target" keys to skip
};

export type SuggestTracesResult = {
  suggestions: TraceSuggestion[];
  scannedFiles: number;
  matchedPairs: number;
};

// Test file patterns for different languages
const TEST_PATTERNS: Array<{
  testPattern: RegExp;
  sourceExtract: (testFile: string) => string | null;
  lang: string;
  confidence: number;
  method: EvidenceMethod;
}> = [
  // Python: test_foo.py -> foo.py
  {
    testPattern: /^test_(.+)\.py$/,
    sourceExtract: (f) => {
      const m = f.match(/^test_(.+)\.py$/);
      return m?.[1] ? `${m[1]}.py` : null;
    },
    lang: 'python',
    confidence: 0.95,
    method: 'exact',
  },
  // Python: foo_test.py -> foo.py
  {
    testPattern: /^(.+)_test\.py$/,
    sourceExtract: (f) => {
      const m = f.match(/^(.+)_test\.py$/);
      return m?.[1] ? `${m[1]}.py` : null;
    },
    lang: 'python',
    confidence: 0.95,
    method: 'exact',
  },
  // TypeScript/JavaScript: foo.test.ts -> foo.ts
  {
    testPattern: /^(.+)\.test\.(ts|tsx|js|jsx)$/,
    sourceExtract: (f) => {
      const m = f.match(/^(.+)\.test\.(ts|tsx|js|jsx)$/);
      return m?.[1] && m[2] ? `${m[1]}.${m[2]}` : null;
    },
    lang: 'typescript',
    confidence: 0.95,
    method: 'exact',
  },
  // TypeScript/JavaScript: foo.spec.ts -> foo.ts
  {
    testPattern: /^(.+)\.spec\.(ts|tsx|js|jsx)$/,
    sourceExtract: (f) => {
      const m = f.match(/^(.+)\.spec\.(ts|tsx|js|jsx)$/);
      return m?.[1] && m[2] ? `${m[1]}.${m[2]}` : null;
    },
    lang: 'typescript',
    confidence: 0.95,
    method: 'exact',
  },
  // Go: foo_test.go -> foo.go
  {
    testPattern: /^(.+)_test\.go$/,
    sourceExtract: (f) => {
      const m = f.match(/^(.+)_test\.go$/);
      return m?.[1] ? `${m[1]}.go` : null;
    },
    lang: 'go',
    confidence: 0.95,
    method: 'exact',
  },
  // Rust: tests/test_foo.rs -> src/foo.rs (heuristic)
  {
    testPattern: /^test_(.+)\.rs$/,
    sourceExtract: (f) => {
      const m = f.match(/^test_(.+)\.rs$/);
      return m?.[1] ? `${m[1]}.rs` : null;
    },
    lang: 'rust',
    confidence: 0.85,
    method: 'heuristic',
  },
];

/**
 * Scan directory recursively and collect all files.
 */
async function collectFiles(
  dir: string,
  relativeTo: string,
  maxFiles: number
): Promise<string[]> {
  const files: string[] = [];
  
  async function walk(currentDir: string): Promise<void> {
    if (files.length >= maxFiles) return;
    
    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (files.length >= maxFiles) break;
        
        const fullPath = path.join(currentDir, entry.name);
        
        // Skip common non-code directories
        if (entry.isDirectory()) {
          if (['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.tox'].includes(entry.name)) {
            continue;
          }
          await walk(fullPath);
        } else if (entry.isFile()) {
          const relativePath = path.relative(relativeTo, fullPath).replace(/\\/g, '/');
          files.push(relativePath);
        }
      }
    } catch {
      // Ignore permission errors etc.
    }
  }
  
  await walk(dir);
  return files;
}

/**
 * Check if a file exists.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the source file for a test file.
 * Tries multiple candidate paths in order of likelihood.
 */
async function findSourceFile(
  testFilePath: string,
  testFileName: string,
  sourceBaseName: string,
  bundleRoot: string,
  repoRoot: string
): Promise<{ path: string; confidence: number; method: EvidenceMethod } | null> {
  const testDir = path.dirname(testFilePath);
  
  // Candidate paths in order of preference
  const candidates: Array<{ path: string; confidence: number; method: EvidenceMethod }> = [];
  
  // 1. Same directory (highest confidence)
  candidates.push({
    path: path.join(testDir, sourceBaseName).replace(/\\/g, '/'),
    confidence: 0.95,
    method: 'exact',
  });
  
  // 2. Parent directory (if test is in tests/ or test/)
  const testDirName = path.basename(testDir);
  if (['tests', 'test', '__tests__', 'spec'].includes(testDirName)) {
    const parentDir = path.dirname(testDir);
    candidates.push({
      path: path.join(parentDir, sourceBaseName).replace(/\\/g, '/'),
      confidence: 0.90,
      method: 'exact',
    });
    
    // 3. Sibling src/ directory
    candidates.push({
      path: path.join(parentDir, 'src', sourceBaseName).replace(/\\/g, '/'),
      confidence: 0.85,
      method: 'heuristic',
    });
    
    // 4. Sibling lib/ directory
    candidates.push({
      path: path.join(parentDir, 'lib', sourceBaseName).replace(/\\/g, '/'),
      confidence: 0.85,
      method: 'heuristic',
    });
  }
  
  // 5. Replace test/ with src/ in path
  if (testFilePath.includes('/tests/') || testFilePath.includes('/test/')) {
    const srcPath = testFilePath
      .replace('/tests/', '/src/')
      .replace('/test/', '/src/')
      .replace(testFileName, sourceBaseName);
    candidates.push({
      path: srcPath,
      confidence: 0.85,
      method: 'heuristic',
    });
  }
  
  // Check each candidate
  for (const candidate of candidates) {
    const fullPath = path.join(bundleRoot, repoRoot, 'norm', candidate.path);
    if (await fileExists(fullPath)) {
      return candidate;
    }
  }
  
  return null;
}

/**
 * Suggest tested_by trace links for a bundle.
 */
export async function suggestTestedByTraces(
  bundleRoot: string,
  input: SuggestTracesInput
): Promise<SuggestTracesResult> {
  const suggestions: TraceSuggestion[] = [];
  let scannedFiles = 0;
  let matchedPairs = 0;
  
  // Find all repos in bundle
  const reposDir = path.join(bundleRoot, 'repos');
  let repoDirs: string[] = [];
  
  try {
    const owners = await fs.readdir(reposDir);
    for (const owner of owners) {
      const ownerDir = path.join(reposDir, owner);
      const stat = await fs.stat(ownerDir);
      if (!stat.isDirectory()) continue;
      
      const repos = await fs.readdir(ownerDir);
      for (const repo of repos) {
        const repoDir = path.join(ownerDir, repo);
        const repoStat = await fs.stat(repoDir);
        if (repoStat.isDirectory()) {
          repoDirs.push(`repos/${owner}/${repo}`);
        }
      }
    }
  } catch {
    return { suggestions: [], scannedFiles: 0, matchedPairs: 0 };
  }
  
  // Scan each repo
  for (const repoRoot of repoDirs) {
    if (suggestions.length >= input.limit) break;
    
    const normDir = path.join(bundleRoot, repoRoot, 'norm');
    
    try {
      await fs.access(normDir);
    } catch {
      continue;
    }
    
    // Collect all files
    const files = await collectFiles(normDir, normDir, 2000);
    scannedFiles += files.length;
    
    // Build file index for quick lookup
    const fileSet = new Set(files);
    
    // Find test files and match them
    for (const filePath of files) {
      if (suggestions.length >= input.limit) break;
      
      const fileName = path.basename(filePath);
      
      // Try each test pattern
      for (const pattern of TEST_PATTERNS) {
        if (!pattern.testPattern.test(fileName)) continue;
        
        const sourceBaseName = pattern.sourceExtract(fileName);
        if (!sourceBaseName) continue;
        
        // Find corresponding source file
        const sourceMatch = await findSourceFile(
          filePath,
          fileName,
          sourceBaseName,
          bundleRoot,
          repoRoot
        );
        
        if (!sourceMatch) continue;
        if (sourceMatch.confidence < input.minConfidence) continue;
        
        // Check if source file exists in our file list
        if (!fileSet.has(sourceMatch.path)) continue;
        
        const testBundlePath = `${repoRoot}/norm/${filePath}`;
        const sourceBundlePath = `${repoRoot}/norm/${sourceMatch.path}`;
        
        // Skip if edge already exists
        const edgeKey = `${sourceBundlePath}|${testBundlePath}`;
        if (input.skipExisting && input.existingEdges?.has(edgeKey)) {
          continue;
        }
        
        matchedPairs++;
        
        const suggestion: TraceSuggestion = {
          type: 'tested_by',
          source: { type: 'file', id: sourceBundlePath },
          target: { type: 'file', id: testBundlePath },
          confidence: Math.min(sourceMatch.confidence, pattern.confidence),
          method: sourceMatch.method,
          why: `${pattern.lang} test pattern: ${fileName} tests ${sourceBaseName}`,
          evidence: [
            {
              file: testBundlePath,
              range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
              note: `Test file matches pattern: ${pattern.testPattern.source}`,
            },
          ],
          upsertPayload: {
            bundleId: input.bundleId,
            dryRun: true,
            edges: [
              {
                type: 'tested_by',
                confidence: Math.min(sourceMatch.confidence, pattern.confidence),
                method: sourceMatch.method,
                source: { type: 'file', id: sourceBundlePath },
                target: { type: 'file', id: testBundlePath },
                sources: [
                  {
                    file: testBundlePath,
                    note: `Auto-suggested: ${pattern.lang} test pattern`,
                  },
                ],
              },
            ],
          },
        };
        
        suggestions.push(suggestion);
        break; // Only one match per test file
      }
    }
  }
  
  return {
    suggestions,
    scannedFiles,
    matchedPairs,
  };
}
