#!/usr/bin/env tsx
/**
 * Batch Index Bundles to ChromaDB
 * 
 * Usage: npx tsx scripts/batch-index-bundles.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { RAGEngine } from '../src/rag/query.js';
import type { RAGConfig } from '../src/rag/types.js';
import { getConfig } from '../src/config.js';
import { createEmbeddingFromConfig } from '../src/embedding/preflightEmbedding.js';

async function main() {
  console.log('=== Batch Index Bundles to ChromaDB ===\n');
  
  // Get bundle directory
  const bundlesDir = process.env.PREFLIGHT_STORAGE_DIR || 'E:\\bundles';
  
  if (!fs.existsSync(bundlesDir)) {
    console.error('Bundles directory not found:', bundlesDir);
    process.exit(1);
  }
  
  // Get all bundle IDs
  const bundleIds = fs.readdirSync(bundlesDir)
    .filter(name => {
      const bundlePath = path.join(bundlesDir, name);
      return fs.statSync(bundlePath).isDirectory() && 
             fs.existsSync(path.join(bundlePath, 'manifest.json'));
    });
  
  console.log(`Found ${bundleIds.length} bundles\n`);
  
  // Initialize RAG engine
  const config = getConfig();
  const { embedding } = createEmbeddingFromConfig(config);
  
  const ragConfig: RAGConfig = {
    chromaUrl: config.chromaUrl || 'http://localhost:8000',
    embedding: {
      embed: async (text: string) => embedding.embed(text),
      embedBatch: async (texts: string[]) => embedding.embedBatch(texts),
    },
  };
  
  const engine = new RAGEngine(ragConfig);
  
  // Check ChromaDB availability
  const available = await engine.isAvailable();
  if (!available) {
    console.error('ChromaDB not available at', ragConfig.chromaUrl);
    process.exit(1);
  }
  
  console.log(`ChromaDB: ${ragConfig.chromaUrl}`);
  console.log(`Embedding: ${config.embeddingModel || 'default'}\n`);
  
  // Index each bundle
  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  
  for (let i = 0; i < bundleIds.length; i++) {
    const bundleId = bundleIds[i]!;
    const bundlePath = path.join(bundlesDir, bundleId);
    
    console.log(`[${i + 1}/${bundleIds.length}] Indexing ${bundleId.slice(0, 8)}...`);
    
    try {
      const result = await engine.indexBundle(bundlePath, bundleId);
      
      if (result.skipped) {
        console.log(`  → Skipped (already indexed, ${result.existingChunks} chunks)`);
        skipped++;
      } else {
        console.log(`  ✓ Indexed ${result.chunksWritten} chunks in ${result.durationMs}ms`);
        indexed++;
      }
    } catch (err) {
      console.log(`  ✗ Failed: ${err}`);
      failed++;
    }
  }
  
  // Summary
  console.log('\n=== Summary ===');
  console.log(`Indexed: ${indexed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed:  ${failed}`);
  console.log(`Total:   ${bundleIds.length}`);
}

main().catch(console.error);
