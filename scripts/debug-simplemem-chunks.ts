/**
 * Debug script to inspect SimpleMem chunking output
 * Run: npx tsx scripts/debug-simplemem-chunks.ts
 */
import * as fs from 'node:fs';
import { academicChunk } from '../src/bridge/pdf-chunker.js';

const SIMPLEMEM_MD = 'E:\\bundles\\460e0e7b-f59a-4325-bd36-2f8c63624d1b\\pdf_Paper_2601.02553_7b9f7fbed855.md';

async function main() {
  const markdown = fs.readFileSync(SIMPLEMEM_MD, 'utf-8');
  
  console.log('=== SimpleMem Markdown First 500 chars ===');
  console.log(markdown.slice(0, 500));
  console.log('\n');
  
  // Chunk the paper (academicChunk is sync)
  const chunks = academicChunk(markdown, {
    sourceType: 'pdf_text',
    bundleId: 'test-bundle',
    filePath: SIMPLEMEM_MD,
  });
  
  console.log(`=== Total Chunks: ${chunks.length} ===\n`);
  
  // Find and inspect chunks that should be L1_pdf (Abstract/Introduction)
  const targetSections = ['abstract', 'introduction', 'summary', 'overview'];
  
  for (const chunk of chunks) {
    const heading = chunk.metadata.sectionHeading?.toLowerCase() || '';
    const headingLevel = chunk.metadata.headingLevel;
    const granularity = chunk.metadata.granularity;
    
    // Check L1_pdf eligibility
    const isL1Candidate = 
      granularity === 'section' &&
      headingLevel === 1 &&
      chunk.metadata.sectionHeading &&
      targetSections.includes(heading);
    
    // Also show all headingLevel=1 chunks
    if (headingLevel === 1 || isL1Candidate) {
      console.log('--- Chunk ---');
      console.log(`ID: ${chunk.id}`);
      console.log(`sectionHeading: "${chunk.metadata.sectionHeading}"`);
      console.log(`headingLevel: ${headingLevel}`);
      console.log(`granularity: ${granularity}`);
      console.log(`headingPath: ${JSON.stringify(chunk.metadata.headingPath)}`);
      console.log(`sourceType: ${chunk.metadata.sourceType}`);
      console.log(`isL1Candidate: ${isL1Candidate}`);
      console.log(`Content (first 200 chars): ${chunk.content.slice(0, 200)}...`);
      console.log('\n');
    }
  }
  
  // Summary
  console.log('=== Summary ===');
  const granularityCounts: Record<string, number> = {};
  const levelCounts: Record<string, number> = {};
  
  for (const chunk of chunks) {
    const g = chunk.metadata.granularity || 'unknown';
    const l = chunk.metadata.headingLevel?.toString() || 'unknown';
    granularityCounts[g] = (granularityCounts[g] || 0) + 1;
    levelCounts[l] = (levelCounts[l] || 0) + 1;
  }
  
  console.log('Granularity counts:', granularityCounts);
  console.log('HeadingLevel counts:', levelCounts);
}

main().catch(console.error);
