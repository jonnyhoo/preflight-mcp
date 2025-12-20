#!/usr/bin/env node
/**
 * Bundle 健康检查和清理工具
 * 检测并可选清理不正常的bundles
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const STORAGE_DIR = 'E:\\coding';

async function checkBundleHealth(bundleId) {
  const bundlePath = path.join(STORAGE_DIR, bundleId);
  
  try {
    const files = await fs.readdir(bundlePath);
    const manifestPath = path.join(bundlePath, 'manifest.json');
    
    // 检查 manifest.json 是否存在
    try {
      const manifest = await fs.readFile(manifestPath, 'utf8');
      const parsed = JSON.parse(manifest);
      
      return {
        bundleId,
        status: 'healthy',
        files: files.length,
        displayName: parsed.displayName || parsed.bundleId,
      };
    } catch (err) {
      return {
        bundleId,
        status: 'unhealthy',
        reason: 'manifest missing or invalid',
        files: files.length,
      };
    }
  } catch (err) {
    return {
      bundleId,
      status: 'error',
      reason: err.message,
    };
  }
}

/**
 * Check if a string is a valid UUID (v4 format).
 */
function isValidBundleId(id) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

async function listAllBundles() {
  try {
    const entries = await fs.readdir(STORAGE_DIR, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && isValidBundleId(entry.name))
      .map(entry => entry.name);
  } catch (err) {
    console.error('无法读取存储目录:', err.message);
    process.exit(1);
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Bundle 健康检查');
  console.log('存储目录:', STORAGE_DIR);
  console.log('='.repeat(60));

  const bundleIds = await listAllBundles();
  console.log(`\n找到 ${bundleIds.length} 个bundles\n`);

  const results = await Promise.all(
    bundleIds.map(id => checkBundleHealth(id))
  );

  const healthy = results.filter(r => r.status === 'healthy');
  const unhealthy = results.filter(r => r.status === 'unhealthy');
  const errors = results.filter(r => r.status === 'error');

  console.log('健康状况统计:');
  console.log(`  ✓ 健康: ${healthy.length}`);
  console.log(`  ✗ 不健康: ${unhealthy.length}`);
  console.log(`  ! 错误: ${errors.length}`);

  if (unhealthy.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('不健康的 Bundles:');
    console.log('='.repeat(60));
    
    for (const bundle of unhealthy) {
      console.log(`\n${bundle.bundleId}`);
      console.log(`  原因: ${bundle.reason}`);
      console.log(`  文件数: ${bundle.files}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('清理建议:');
    console.log('='.repeat(60));
    console.log('\n使用 preflight_delete_bundle 工具删除不健康的bundles:');
    for (const bundle of unhealthy) {
      console.log(`  - ${bundle.bundleId}`);
    }
    
    console.log('\n或手动删除目录:');
    for (const bundle of unhealthy) {
      console.log(`  Remove-Item -Recurse -Force "E:\\coding\\${bundle.bundleId}"`);
    }
  }

  if (healthy.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('健康的 Bundles (前10个):');
    console.log('='.repeat(60));
    
    for (const bundle of healthy.slice(0, 10)) {
      console.log(`  ✓ ${bundle.bundleId} (${bundle.displayName})`);
    }
    
    if (healthy.length > 10) {
      console.log(`  ... 还有 ${healthy.length - 10} 个`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('检查完成');
  console.log('='.repeat(60));
}

main().catch(console.error);
