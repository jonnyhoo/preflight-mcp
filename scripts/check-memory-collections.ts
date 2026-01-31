import { ChromaVectorDB } from '../src/vectordb/chroma-client.js';
import { getConfig } from '../src/config.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import { getCollectionName, MEMORY_LAYERS } from '../src/memory/types.js';

async function main() {
  console.log('Loading config...');
  const cfg = getConfig();
  
  const chromaDB = new ChromaVectorDB({ url: cfg.chromaUrl });
  
  console.log(`Connecting to ChromaDB at ${cfg.chromaUrl}...`);
  
  // Check connection
  const available = await chromaDB.isAvailable();
  if (!available) {
    throw new Error('ChromaDB is not available');
  }
  
  console.log('✅ ChromaDB connected');
  
  // Get all collections from ChromaDB
  console.log('\nFetching all collections from ChromaDB...');
  const allCollections = await chromaDB.listAllCollections();
  
  console.log(`\nFound ${allCollections.length} total collections:`);
  for (const collection of allCollections) {
    console.log(`  - ${collection.name} (${collection.id})`);
  }
  
  // Check for memory collections specifically
  console.log('\n🔍 Checking for preflight_mem_ prefixed collections...');
  const memoryCollectionNames = MEMORY_LAYERS.map(layer => getCollectionName(layer));
  console.log('Expected memory collections:', memoryCollectionNames);
  
  const foundMemoryCollections = [];
  const missingMemoryCollections = [];
  
  for (const layer of MEMORY_LAYERS) {
    const expectedName = getCollectionName(layer);
    const found = allCollections.find(col => col.name === expectedName);
    
    if (found) {
      const count = await chromaDB.getCollectionCount(found.name);
      console.log(`✅ Found: ${expectedName} (ID: ${found.id}, Documents: ${count})`);
      foundMemoryCollections.push({ name: expectedName, id: found.id, count });
    } else {
      console.log(`❌ Missing: ${expectedName}`);
      missingMemoryCollections.push(expectedName);
    }
  }
  
  // Summary
  console.log('\n📊 Summary:');
  console.log(`Found: ${foundMemoryCollections.length} memory collections`);
  console.log(`Missing: ${missingMemoryCollections.length} memory collections`);
  
  if (foundMemoryCollections.length > 0) {
    console.log('\n📋 Found Memory Collections Details:');
    for (const col of foundMemoryCollections) {
      console.log(`  - ${col.name}: ${col.count} documents`);
    }
  }
  
  if (missingMemoryCollections.length > 0) {
    console.log('\n⚠️  Missing Collections:');
    for (const col of missingMemoryCollections) {
      console.log(`  - ${col}`);
    }
    console.log('\n💡 Tip: You can create missing collections by initializing the MemoryStore.');
  } else {
    console.log('\n🎉 All memory collections exist!');
  }
  
  // Test creating a memory store to ensure collections are properly initialized
  console.log('\n🧪 Testing MemoryStore initialization...');
  try {
    const memoryStore = new MemoryStore({ chromaUrl: cfg.chromaUrl });
    await memoryStore.ensureCollections(); // This should create any missing collections
    console.log('✅ MemoryStore initialized and collections ensured.');
    await memoryStore.close();
  } catch (error) {
    console.error('❌ Error initializing MemoryStore:', error);
  }
}

main().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});