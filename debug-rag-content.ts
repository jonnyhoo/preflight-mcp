import { ChromaVectorDB } from './src/vectordb/chroma-client.js';
import { DEFAULT_CHROMA_CONFIG } from './src/vectordb/types.js';

// 使用默认配置连接到 ChromaDB
const config = { ...DEFAULT_CHROMA_CONFIG };
if (process.env.CHROMA_URL) {
  config.url = process.env.CHROMA_URL;
}

const chromaDB = new ChromaVectorDB(config);

async function checkChromaDB() {
  try {
    // 检查服务器是否可用
    const isAvailable = await chromaDB.isAvailable();
    console.log('ChromaDB available:', isAvailable);
    
    if (!isAvailable) {
      console.log('ChromaDB server is not available. Please make sure it is running.');
      return;
    }

    // 获取版本信息
    try {
      const version = await chromaDB.getVersion();
      console.log('ChromaDB version:', version);
    } catch (err) {
      console.log('Could not get ChromaDB version:', err.message);
    }

    // 列出所有集合
    console.log('\n--- Listing all collections ---');
    try {
      const collections = await chromaDB.listAllCollections();
      console.log('Collections found:', collections.length);
      for (const col of collections) {
        const count = await chromaDB.getCollectionCount(col.name);
        console.log(`  ${col.name}: ${count} documents`);
      }
    } catch (err) {
      console.log('Error listing collections:', err.message);
    }

    // 尝试获取分层内容
    console.log('\n--- Listing hierarchical content ---');
    try {
      const indexedContent = await chromaDB.listHierarchicalContent();
      console.log('Indexed content items:', indexedContent.length);
      if (indexedContent.length > 0) {
        for (let i = 0; i < Math.min(10, indexedContent.length); i++) {
          const item = indexedContent[i];
          console.log(`  ${i + 1}. ${item.id} (${item.type})`);
          console.log(`     Paper: ${item.paperId || 'N/A'}, Bundle: ${item.bundleId || 'N/A'}`);
          console.log(`     L1: ${item.l1Count}, L2: ${item.l2Count}, L3: ${item.l3Count} (Total: ${item.totalChunks})`);
          if (item.paperTitle) {
            console.log(`     Title: ${item.paperTitle}`);
          }
        }
        if (indexedContent.length > 10) {
          console.log(`  ... and ${indexedContent.length - 10} more items`);
        }
      } else {
        console.log('  No indexed content found');
      }
    } catch (err) {
      console.log('Error getting hierarchical content:', err.message);
      console.log('Stack trace:', err.stack);
    }

    // 获取分层统计信息
    console.log('\n--- Getting hierarchical stats ---');
    try {
      const stats = await chromaDB.getHierarchicalStats();
      console.log('Total chunks:', stats.totalChunks);
      console.log('By level:', stats.byLevel);
      console.log('By paper ID:', stats.byPaperId);
    } catch (err) {
      console.log('Error getting hierarchical stats:', err.message);
    }

  } catch (err) {
    console.log('Error connecting to ChromaDB:', err.message);
    console.log('Stack trace:', err.stack);
  }
}

// 运行检查
checkChromaDB();