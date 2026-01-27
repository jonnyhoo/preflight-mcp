/**
 * Clear all ChromaDB collections
 * Usage: npx tsx scripts/clear-chromadb.ts
 */

import { ChromaVectorDB } from '../src/vectordb/chroma-client.js';
import { loadConfig } from '../src/config.js';

async function main() {
  console.log('Loading config...');
  const cfg = await loadConfig();
  
  const chromaDB = new ChromaVectorDB({ url: cfg.chromaUrl });
  
  console.log(`Connecting to ChromaDB at ${cfg.chromaUrl}...`);
  
  // Check connection
  const available = await chromaDB.isAvailable();
  if (!available) {
    throw new Error('ChromaDB is not available');
  }
  
  console.log('✅ ChromaDB connected');
  
  // Delete collections
  const collections: Array<'chunks' | 'entities' | 'relations'> = ['chunks', 'entities', 'relations'];
  
  for (const type of collections) {
    try {
      console.log(`Deleting collection: preflight_${type}...`);
      await chromaDB.deleteCollection(type);
      console.log(`✅ Deleted: preflight_${type}`);
    } catch (err) {
      console.warn(`⚠️  Failed to delete preflight_${type}: ${err}`);
    }
  }
  
  console.log('\n✅ All collections cleared!');
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
