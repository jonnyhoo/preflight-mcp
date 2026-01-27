/**
 * Debug script to investigate SimpleMem chunking issue
 */

import { readFileSync } from 'node:fs';
import { academicChunk } from './src/bridge/pdf-chunker.js';

const simplememMarkdown = readFileSync(
  'E:\\\\bundles\\\\460e0e7b-f59a-4325-bd36-2f8c63624d1b\\\\pdf_Paper_2601.02553_7b9f7fbed855.md',
  'utf-8'
);

console.log('=== SimpleMem Markdown Analysis ===');
console.log('Total length:', simplememMarkdown.length);
console.log('Total lines:', simplememMarkdown.split('\n').length);

// Count headings by level
const headings = simplememMarkdown.match(/^#+\s+.+$/gm) || [];
console.log('\nTotal headings:', headings.length);
console.log('Sample headings:', headings.slice(0, 10));

// Test chunking
const chunks = academicChunk(
  simplememMarkdown,
  {
    sourceType: 'pdf_text',
    bundleId: 'test-bundle',
    repoId: 'test-repo',
    filePath: 'test.md',
  },
  {
    strategy: 'semantic',
    chunkLevel: 2,
  }
);

console.log('\n=== Chunking Results ===');
console.log('Total chunks:', chunks.length);
console.log('\nChunks by type:');
const typeCount = chunks.reduce((acc, c) => {
  acc[c.chunkType] = (acc[c.chunkType] || 0) + 1;
  return acc;
}, {} as Record<string, number>);
console.log(typeCount);

console.log('\nChunks by granularity:');
const granularityCount = chunks.reduce((acc, c) => {
  const g = c.metadata.granularity || 'unknown';
  acc[g] = (acc[g] || 0) + 1;
  return acc;
}, {} as Record<string, number>);
console.log(granularityCount);

console.log('\nFirst 5 chunks:');
chunks.slice(0, 5).forEach((chunk, i) => {
  console.log(`\n[${i}] ${chunk.chunkType} | ${chunk.metadata.granularity} | ${chunk.metadata.sectionHeading}`);
  console.log(`    ID: ${chunk.id}`);
  console.log(`    Parent: ${chunk.metadata.parentChunkId || 'none'}`);
  console.log(`    Content preview: ${chunk.content.slice(0, 150)}...`);
});
