#!/usr/bin/env node
/**
 * 测试 preflight_list_bundles 方法
 * 使用 MCP SDK Client
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname);

console.log('='.repeat(60));
console.log('测试 preflight_list_bundles');
console.log('='.repeat(60));

const client = new Client({ name: 'test-list-client', version: '1.0.0' });

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(repoRoot, 'dist', 'index.js')],
  cwd: repoRoot,
  env: {
    PREFLIGHT_STORAGE_DIR: 'E:\\coding',
  },
  stderr: 'inherit',
});

try {
  console.log('\n[1] 连接到MCP服务器...');
  await client.connect(transport);
  console.log('✓ 连接成功');

  // 测试1: 基本列表（无过滤）
  console.log('\n[2] 测试基本列表（无过滤）...');
  const listRes1 = await client.callTool({
    name: 'preflight_list_bundles',
    arguments: {
      limit: 50,
      maxItemsPerList: 10,
    },
  });

  console.log('\n' + '='.repeat(60));
  console.log('结果1: 基本列表');
  console.log('='.repeat(60));
  
  if (listRes1.isError) {
    console.error('错误:', listRes1.content);
  } else {
    // 显示文本输出
    const textContent = listRes1.content?.find((c) => c.type === 'text')?.text;
    if (textContent) {
      console.log('\n文本输出:');
      console.log(textContent);
    }

    // 显示结构化数据
    if (listRes1.structuredContent) {
      console.log('\n结构化数据:');
      console.log(JSON.stringify(listRes1.structuredContent, null, 2));
      
      const bundles = listRes1.structuredContent.bundles;
      console.log(`\n总共找到 ${bundles?.length || 0} 个 bundles`);
    }
  }

  // 测试2: 标签过滤
  console.log('\n[3] 测试标签过滤 (filterByTag: "mcp")...');
  const listRes2 = await client.callTool({
    name: 'preflight_list_bundles',
    arguments: {
      filterByTag: 'mcp',
      limit: 20,
    },
  });

  console.log('\n' + '='.repeat(60));
  console.log('结果2: 标签过滤 (mcp)');
  console.log('='.repeat(60));
  
  if (!listRes2.isError) {
    const textContent = listRes2.content?.find((c) => c.type === 'text')?.text;
    if (textContent) {
      console.log(textContent);
    }
    
    const bundles = listRes2.structuredContent?.bundles;
    console.log(`\n过滤后找到 ${bundles?.length || 0} 个 bundles`);
  }

  // 测试3: 限制数量
  console.log('\n[4] 测试限制数量 (limit: 5, maxItemsPerList: 3)...');
  const listRes3 = await client.callTool({
    name: 'preflight_list_bundles',
    arguments: {
      limit: 5,
      maxItemsPerList: 3,
    },
  });

  console.log('\n' + '='.repeat(60));
  console.log('结果3: 限制数量');
  console.log('='.repeat(60));
  
  if (!listRes3.isError) {
    const textContent = listRes3.content?.find((c) => c.type === 'text')?.text;
    if (textContent) {
      console.log(textContent);
    }
    
    const bundles = listRes3.structuredContent?.bundles;
    console.log(`\n返回 ${bundles?.length || 0} 个 bundles`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('✓ 测试完成');
  console.log('='.repeat(60));

} catch (err) {
  console.error('\n✗ 测试失败:', err.message);
  console.error(err);
  process.exit(1);
} finally {
  await client.close().catch(() => undefined);
}
