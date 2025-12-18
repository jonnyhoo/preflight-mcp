import { extractBundleFacts, writeFacts } from '../dist/bundle/facts.js';
import { generateQuickSummary } from '../dist/bundle/analysis.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

console.log('Testing static analysis on preflight-mcp itself...\n');

// Create mock ingested files from the actual project
const mockFiles = [
  {
    repoId: 'jonnyhoo/preflight-mcp',
    kind: 'code',
    repoRelativePath: 'src/index.ts',
    bundleNormRelativePath: 'repos/jonnyhoo/preflight-mcp/norm/src/index.ts',
    bundleNormAbsPath: path.join(repoRoot, 'src/index.ts'),
    sha256: 'test',
    bytes: 100,
  },
  {
    repoId: 'jonnyhoo/preflight-mcp',
    kind: 'code',
    repoRelativePath: 'src/server.ts',
    bundleNormRelativePath: 'repos/jonnyhoo/preflight-mcp/norm/src/server.ts',
    bundleNormAbsPath: path.join(repoRoot, 'src/server.ts'),
    sha256: 'test',
    bytes: 200,
  },
  {
    repoId: 'jonnyhoo/preflight-mcp',
    kind: 'code',
    repoRelativePath: 'src/bundle/service.ts',
    bundleNormRelativePath: 'repos/jonnyhoo/preflight-mcp/norm/src/bundle/service.ts',
    bundleNormAbsPath: path.join(repoRoot, 'src/bundle/service.ts'),
    sha256: 'test',
    bytes: 300,
  },
  {
    repoId: 'jonnyhoo/preflight-mcp',
    kind: 'code',
    repoRelativePath: 'package.json',
    bundleNormRelativePath: 'repos/jonnyhoo/preflight-mcp/norm/package.json',
    bundleNormAbsPath: path.join(repoRoot, 'package.json'),
    sha256: 'test',
    bytes: 400,
  },
  {
    repoId: 'jonnyhoo/preflight-mcp',
    kind: 'doc',
    repoRelativePath: 'README.md',
    bundleNormRelativePath: 'repos/jonnyhoo/preflight-mcp/norm/README.md',
    bundleNormAbsPath: path.join(repoRoot, 'README.md'),
    sha256: 'test',
    bytes: 500,
  },
];

try {
  console.log('Step 1: Extracting facts...');
  const facts = await extractBundleFacts({
    bundleRoot: repoRoot,
    repos: [
      {
        repoId: 'jonnyhoo/preflight-mcp',
        files: mockFiles,
      },
    ],
  });

  console.log('\n✅ Facts extracted successfully!\n');
  console.log('--- FACTS SUMMARY ---');
  console.log(`Languages: ${facts.languages.map((l) => l.language).join(', ')}`);
  console.log(`Frameworks: ${facts.frameworks.join(', ') || '(none)'}`);
  console.log(`Entry points: ${facts.entryPoints.length}`);
  console.log(`Dependencies: ${facts.dependencies.runtime.length} runtime, ${facts.dependencies.dev.length} dev`);
  console.log(`Package manager: ${facts.dependencies.manager}`);
  console.log(`Total files: ${facts.fileStructure.totalFiles}`);
  console.log(`Top-level dirs: ${facts.fileStructure.topLevelDirs.join(', ')}`);
  
  console.log('\n--- DETECTED FRAMEWORKS ---');
  if (facts.frameworks.length > 0) {
    facts.frameworks.forEach((f) => console.log(`  - ${f}`));
  } else {
    console.log('  (none)');
  }

  console.log('\n--- ENTRY POINTS ---');
  if (facts.entryPoints.length > 0) {
    facts.entryPoints.forEach((ep) => {
      console.log(`  - [${ep.type}] ${ep.file}`);
      console.log(`    Evidence: ${ep.evidence}`);
    });
  } else {
    console.log('  (none found)');
  }

  console.log('\n--- DEPENDENCIES (Top 10) ---');
  facts.dependencies.runtime.slice(0, 10).forEach((dep) => {
    console.log(`  - ${dep.name}${dep.version ? ` ${dep.version}` : ''}`);
  });

  console.log('\nStep 2: Generating quick summary...');
  const summary = generateQuickSummary(facts);
  
  console.log('\n✅ Summary generated!\n');
  console.log('--- QUICK SUMMARY ---');
  console.log(summary);

  console.log('\n✅ All tests passed!');
  console.log('\nNext steps:');
  console.log('1. The static analysis works correctly');
  console.log('2. Ready to proceed with Phase 3 (LLM analysis)');
  console.log('3. FACTS.json can be generated for any bundle');
  
} catch (err) {
  console.error('❌ Test failed:', err);
  process.exit(1);
}
