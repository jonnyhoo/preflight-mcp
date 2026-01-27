/**
 * Debug script to check if embeddings are generated for all chunks
 */

import { readFileSync } from 'node:fs';
import { academicChunk } from './src/bridge/pdf-chunker.js';
import { OpenAIEmbedding } from './src/embedding/openai.js';

const simplememMarkdown = readFileSync(
  'E:\\\\bundles\\\\460e0e7b-f59a-4325-bd36-2f8c63624d1b\\\\pdf_Paper_2601.02553_7b9f7fbed855.md',
  'utf-8'
);

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

console.log(`Total chunks: ${chunks.length}`);

// Check content lengths
const contentLengths = chunks.map(c => c.content.length);
console.log('\nContent length distribution:');
console.log(`  Min: ${Math.min(...contentLengths)}`);
console.log(`  Max: ${Math.max(...contentLengths)}`);
console.log(`  Avg: ${Math.floor(contentLengths.reduce((a,b) => a+b, 0) / contentLengths.length)}`);

// Check for very short chunks (might fail embedding)
const veryShortChunks = chunks.filter(c => c.content.length < 50);
console.log(`\nVery short chunks (<50 chars): ${veryShortChunks.length}`);
veryShortChunks.forEach(c => {
  console.log(`  [${c.chunkType}] ${c.metadata.sectionHeading}: "${c.content.substring(0, 60)}"`);
});

// Try to generate embeddings
console.log('\n=== Testing Embedding Generation ===');
const embedding = new OpenAIEmbedding();

try {
  const texts = chunks.map(c => c.content);
  console.log(`Generating embeddings for ${texts.length} chunks...`);
  
  const embeddings = await embedding.embedBatch(texts);
  console.log(`Generated ${embeddings.length} embeddings`);
  
  // Check for null/empty embeddings
  const nullEmbeddings = embeddings.filter(e => !e || !e.vector || e.vector.length === 0);
  console.log(`Null/empty embeddings: ${nullEmbeddings.length}`);
  
  if (nullEmbeddings.length > 0) {
    console.log('\nChunks with failed embeddings:');
    embeddings.forEach((e, i) => {
      if (!e || !e.vector || e.vector.length === 0) {
        const chunk = chunks[i];
        console.log(`  [${i}] ${chunk?.chunkType} | ${chunk?.metadata.sectionHeading}`);
        console.log(`      Content: "${chunk?.content.substring(0, 100)}"`);
      }
    });
  }
  
} catch (err) {
  console.error('Embedding generation failed:', err);
}
