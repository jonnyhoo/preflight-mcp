#!/usr/bin/env node
/**
 * Integration test for EDDA tools.
 * Run with: node scripts/test-edda.mjs <bundleId>
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Dynamic imports for built modules (convert to file:// URL for Windows)
const toFileUrl = (p) => pathToFileURL(p).href;
const { suggestTestedByTraces } = await import(toFileUrl(path.join(projectRoot, 'dist/trace/suggest.js')));
const { buildDeepAnalysis } = await import(toFileUrl(path.join(projectRoot, 'dist/analysis/deep.js')));
const { validateReport } = await import(toFileUrl(path.join(projectRoot, 'dist/analysis/validate.js')));
const { generateRepoTree } = await import(toFileUrl(path.join(projectRoot, 'dist/bundle/tree.js')));

const bundleId = process.argv[2] || '06ab1575-1feb-4ade-8bae-8aadecb78915';
const bundleRoot = process.argv[3] || `E:\\bundles\\${bundleId}`;

console.log('='.repeat(60));
console.log('EDDA Integration Test');
console.log('='.repeat(60));
console.log(`Bundle ID: ${bundleId}`);
console.log(`Bundle Root: ${bundleRoot}`);
console.log('');

// Test 1: suggestTestedByTraces
console.log('--- Test 1: suggestTestedByTraces ---');
try {
  const suggestResult = await suggestTestedByTraces(bundleRoot, {
    bundleId,
    edgeType: 'tested_by',
    scope: 'repo',
    minConfidence: 0.8,
    limit: 10,
    skipExisting: false,
  });
  console.log(`✅ Scanned ${suggestResult.scannedFiles} files`);
  console.log(`✅ Found ${suggestResult.matchedPairs} test pairs`);
  console.log(`✅ Suggestions: ${suggestResult.suggestions.length}`);
  if (suggestResult.suggestions.length > 0) {
    const s = suggestResult.suggestions[0];
    console.log(`   Sample: ${s.source.id} <- ${s.target.id} (${s.confidence})`);
  }
} catch (err) {
  console.log(`❌ Error: ${err.message}`);
}
console.log('');

// Test 2: generateRepoTree (with new options)
console.log('--- Test 2: generateRepoTree (enhanced) ---');
try {
  const treeResult = await generateRepoTree(bundleRoot, bundleId, {
    depth: 3,
    showFileCountPerDir: true,
  });
  console.log(`✅ Total files: ${treeResult.stats.totalFiles}`);
  console.log(`✅ Total dirs: ${treeResult.stats.totalDirs}`);
  console.log(`✅ Entry points found: ${treeResult.entryPointCandidates.length}`);
  const topExts = Object.entries(treeResult.stats.byExtension)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  console.log(`✅ Top extensions: ${topExts.map(([e, c]) => `${e}(${c})`).join(', ')}`);
} catch (err) {
  console.log(`❌ Error: ${err.message}`);
}
console.log('');

// Test 3: buildDeepAnalysis
console.log('--- Test 3: buildDeepAnalysis ---');
try {
  const deepResult = buildDeepAnalysis(bundleId, {
    tree: {
      totalFiles: 50,
      totalDirs: 10,
      byExtension: { '.ts': 30, '.js': 15, '.json': 5 },
      topDirs: [{ path: 'src', fileCount: 35 }, { path: 'tests', fileCount: 10 }],
    },
    deps: {
      totalNodes: 25,
      totalEdges: 40,
      topImporters: [{ file: 'src/index.ts', count: 8 }],
      topImported: [{ file: 'src/utils.ts', count: 6 }],
    },
    traces: {
      totalLinks: 5,
      byType: { tested_by: 5 },
      coverageEstimate: 0.2,
    },
  });
  console.log(`✅ Summary generated (${deepResult.summary.length} chars)`);
  console.log(`✅ Next steps: ${deepResult.nextSteps.length}`);
  console.log(`✅ Coverage report: scanned=${deepResult.coverageReport.scannedFilesCount}`);
} catch (err) {
  console.log(`❌ Error: ${err.message}`);
}
console.log('');

// Test 4: validateReport
console.log('--- Test 4: validateReport ---');
try {
  const validateResult = await validateReport(bundleRoot, {
    bundleId,
    claims: [
      {
        id: 'test-claim-1',
        text: 'This is a test claim with valid evidence',
        confidence: 0.9,
        kind: 'feature',
        status: 'supported',
        evidence: [
          {
            file: 'repos/local/DeepAudit-3.0.0/norm/README.md',
            range: { startLine: 1, startCol: 1, endLine: 10, endCol: 1 },
          },
        ],
      },
      {
        id: 'test-claim-2',
        text: 'This claim has no evidence',
        confidence: 0.5,
        kind: 'unknown',
        status: 'supported',
        evidence: [],
      },
      {
        id: 'test-claim-3',
        text: 'This claim references non-existent file',
        confidence: 0.7,
        kind: 'module',
        status: 'supported',
        evidence: [
          {
            file: 'nonexistent/path/file.ts',
            range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
          },
        ],
      },
    ],
  });
  console.log(`✅ Total claims: ${validateResult.totalClaims}`);
  console.log(`✅ Valid: ${validateResult.validClaims}, Invalid: ${validateResult.invalidClaims}`);
  console.log(`✅ Issues found: ${validateResult.issues.length}`);
  console.log(`✅ Passed: ${validateResult.passed}`);
  for (const issue of validateResult.issues.slice(0, 3)) {
    console.log(`   [${issue.severity}] ${issue.code}: ${issue.message}`);
  }
} catch (err) {
  console.log(`❌ Error: ${err.message}`);
}

console.log('');
console.log('='.repeat(60));
console.log('Test Complete');
console.log('='.repeat(60));
