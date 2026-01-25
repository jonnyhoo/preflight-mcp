/**
 * RAG Test Script - Validates the complete RAG flow.
 * 
 * Usage:
 *   npx tsx tests/rag/rag-engine.test.ts <bundlePath> [chromaUrl]
 * 
 * Example:
 *   npx tsx tests/rag/rag-engine.test.ts E:/bundles/my-project http://localhost:8000
 * 
 * @module tests/rag/rag-engine
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RAGEngine } from '../../src/rag/query.js';
import type { RAGConfig } from '../../src/rag/types.js';
import { createEmbedding } from '../../src/embedding/index.js';
import type { EmbeddingConfig } from '../../src/embedding/types.js';

// ============================================================================
// Test Configuration
// ============================================================================

const CHROMA_URL = process.argv[3] ?? 'https://chromadb.sicko.top:16669';
const BUNDLE_PATH = process.argv[2];

if (!BUNDLE_PATH) {
  console.error('Usage: npx tsx tests/rag/rag-engine.test.ts <bundlePath> [chromaUrl]');
  console.error('');
  console.error('Example:');
  console.error('  npx tsx tests/rag/rag-engine.test.ts E:/bundles/my-project http://localhost:8000');
  process.exit(1);
}

// ============================================================================
// Mock Embedding (for testing without Ollama/OpenAI)
// ============================================================================

class MockEmbedding {
  private dimension = 384;

  async embed(text: string): Promise<{ vector: number[] }> {
    // Generate deterministic embedding based on text hash
    const vector = this.generateVector(text);
    return { vector };
  }

  async embedBatch(texts: string[]): Promise<Array<{ vector: number[] }>> {
    return texts.map(text => ({ vector: this.generateVector(text) }));
  }

  private generateVector(text: string): number[] {
    // Simple hash-based pseudo-random vector
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }

    const vector: number[] = [];
    for (let i = 0; i < this.dimension; i++) {
      // Use hash to seed pseudo-random values
      hash = (hash * 1103515245 + 12345) & 0x7fffffff;
      vector.push((hash / 0x7fffffff) * 2 - 1);
    }

    // Normalize
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return vector.map(v => v / norm);
  }
}

// ============================================================================
// Load config from ~/.preflight/config.json
// ============================================================================

interface PreflightConfig {
  embeddingEnabled?: boolean;
  embeddingProvider?: 'ollama' | 'openai';
  embeddingApiBase?: string;
  embeddingApiKey?: string;
  embeddingModel?: string;
  llmEnabled?: boolean;
  llmApiBase?: string;
  llmApiKey?: string;
  llmModel?: string;
}

function loadConfig(): PreflightConfig {
  const configPath = path.join(os.homedir(), '.preflight', 'config.json');
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

// ============================================================================
// Try to use real embedding, fallback to mock
// ============================================================================

async function createEmbeddingProvider(): Promise<RAGConfig['embedding']> {
  const config = loadConfig();

  // Try config file embedding first
  if (config.embeddingEnabled && config.embeddingProvider === 'openai' && config.embeddingApiKey) {
    console.log(`Trying OpenAI embedding: ${config.embeddingApiBase} / ${config.embeddingModel}`);
    try {
      const openaiConfig: EmbeddingConfig = {
        provider: 'openai',
        apiKey: config.embeddingApiKey,
        model: config.embeddingModel ?? 'text-embedding-3-small',
        baseUrl: config.embeddingApiBase,
      };
      const openai = createEmbedding(openaiConfig);
      
      // Try embed directly instead of isAvailable
      console.log('Testing embedding...');
      const testResult = await openai.embed('test');
      console.log(`Embedding dimension: ${testResult.dimension}`);
      
      console.log(`✓ Using OpenAI embedding (${config.embeddingModel})`);
      return {
        embed: async (text: string) => openai.embed(text),
        embedBatch: async (texts: string[]) => openai.embedBatch(texts),
      };
    } catch (err) {
      console.log(`⚠ OpenAI embedding failed: ${err}`);
    }
  } else {
    console.log(`Config: enabled=${config.embeddingEnabled}, provider=${config.embeddingProvider}, hasKey=${!!config.embeddingApiKey}`);
  }

  // Try Ollama (local, free)
  try {
    const ollamaConfig: EmbeddingConfig = {
      provider: 'ollama',
      host: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
      model: process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text',
    };
    const ollama = createEmbedding(ollamaConfig);
    const available = await ollama.isAvailable();
    
    if (available) {
      console.log('✓ Using Ollama embedding');
      return {
        embed: async (text: string) => ollama.embed(text),
        embedBatch: async (texts: string[]) => ollama.embedBatch(texts),
      };
    }
  } catch {
    // Ollama not available
  }

  // Fallback to mock
  console.log('⚠ Using mock embedding (no embedding provider available)');
  const mock = new MockEmbedding();
  return {
    embed: async (text: string) => mock.embed(text),
    embedBatch: async (texts: string[]) => mock.embedBatch(texts),
  };
}

// ============================================================================
// Main Test
// ============================================================================

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Preflight RAG MVP Test');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`Bundle Path: ${BUNDLE_PATH}`);
  console.log(`ChromaDB URL: ${CHROMA_URL}`);
  console.log('');

  // Create embedding provider
  const embedding = await createEmbeddingProvider();

  // Create RAG config
  const config: RAGConfig = {
    chromaUrl: CHROMA_URL,
    embedding,
    // No LLM for now - will return raw context
  };

  // Create RAG engine
  const engine = new RAGEngine(config);

  // Check ChromaDB availability
  console.log('Checking ChromaDB connection...');
  const available = await engine.isAvailable();
  
  if (!available) {
    console.error('✗ ChromaDB not available at', CHROMA_URL);
    console.error('');
    console.error('Please start ChromaDB:');
    console.error('  docker run -p 8000:8000 chromadb/chroma');
    console.error('  # or');
    console.error('  pip install chromadb && chroma run');
    process.exit(1);
  }
  console.log('✓ ChromaDB connected');
  console.log('');

  // Extract bundle ID from path
  const bundleId = BUNDLE_PATH!.split(/[/\\]/).pop() ?? 'test-bundle';

  // -------------------------------------------------------------------------
  // Test 1: Index Bundle
  // -------------------------------------------------------------------------
  console.log('───────────────────────────────────────────────────────────────');
  console.log('  1. Index Bundle');
  console.log('───────────────────────────────────────────────────────────────');
  
  const indexResult = await engine.indexBundle(BUNDLE_PATH!, bundleId);
  
  console.log('');
  console.log('Index Result:');
  console.log(`  Chunks Written: ${indexResult.chunksWritten}`);
  console.log(`  Entities Count: ${indexResult.entitiesCount ?? 0}`);
  console.log(`  Relations Count: ${indexResult.relationsCount ?? 0}`);
  console.log(`  Duration: ${indexResult.durationMs}ms`);
  
  if (indexResult.errors.length > 0) {
    console.log(`  Errors: ${indexResult.errors.length}`);
    indexResult.errors.slice(0, 3).forEach(e => console.log(`    - ${e}`));
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Test 2: RAG Query
  // -------------------------------------------------------------------------
  console.log('───────────────────────────────────────────────────────────────');
  console.log('  2. RAG Query');
  console.log('───────────────────────────────────────────────────────────────');
  
  const testQueries = [
    '这个项目的核心模块是什么？',
    'What are the main features?',
    'How do I get started?',
  ];

  for (const query of testQueries) {
    console.log('');
    console.log(`Query: "${query}"`);
    console.log('');
    
    const result = await engine.query(query, {
      mode: 'hybrid',
      topK: 5,
      bundleId,
    });

    console.log('Answer:');
    console.log(result.answer.slice(0, 500) + (result.answer.length > 500 ? '...' : ''));
    console.log('');
    console.log('Stats:');
    console.log(`  Chunks Retrieved: ${result.stats.chunksRetrieved}`);
    console.log(`  Graph Expansion: ${result.stats.graphExpansion}`);
    console.log(`  Duration: ${result.stats.durationMs}ms`);
    
    if (result.sources.length > 0) {
      console.log('');
      console.log('Sources:');
      result.sources.slice(0, 3).forEach((s, i) => {
        console.log(`  ${i + 1}. [${s.sourceType}] ${s.repoId ?? s.filePath ?? 'unknown'}`);
      });
    }
    console.log('');
    console.log('─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─');
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Test Complete');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('RAG MVP is working! To add LLM-generated answers:');
  console.log('  - Set OPENAI_API_KEY or configure Ollama with a chat model');
  console.log('  - Pass llm config to RAGEngine');
  console.log('');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
