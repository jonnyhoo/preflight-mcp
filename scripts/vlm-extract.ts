#!/usr/bin/env tsx
/**
 * CLI tool for VLM extraction
 * 
 * Usage:
 *   npx tsx scripts/vlm-extract.ts <pdf-path> [options]
 *   
 * Options:
 *   --page <n>          Extract specific page (1-based)
 *   --start <n>         Start page (1-based, default: 1)
 *   --end <n>           End page (1-based, default: last)
 *   --describe          Describe each page before extraction
 *   --no-formulas       Skip formula extraction
 *   --no-tables         Skip table extraction
 *   --no-code           Skip code extraction
 *   --force-all         Extract from all pages (skip detection)
 *   --output <file>     Save output to file
 * 
 * Examples:
 *   npx tsx scripts/vlm-extract.ts paper.pdf
 *   npx tsx scripts/vlm-extract.ts paper.pdf --page 6
 *   npx tsx scripts/vlm-extract.ts paper.pdf --start 5 --end 10 --describe
 */

import { extractFromPDF, formatAsMarkdown, getVLMConfig } from '../src/distill/vlm-extractor.js';
import fs from 'fs/promises';

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
VLM Extraction Tool

Usage: npx tsx scripts/vlm-extract.ts <pdf-path> [options]

Options:
  --page <n>          Extract specific page (1-based)
  --start <n>         Start page (1-based, default: 1)
  --end <n>           End page (1-based, default: last)
  --describe          Describe each page before extraction
  --no-formulas       Skip formula extraction
  --no-tables         Skip table extraction
  --no-code           Skip code extraction
  --force-all         Extract from all pages (skip detection)
  --output <file>     Save output to file

Examples:
  npx tsx scripts/vlm-extract.ts paper.pdf
  npx tsx scripts/vlm-extract.ts paper.pdf --page 6
  npx tsx scripts/vlm-extract.ts paper.pdf --start 5 --end 10 --describe
`);
    process.exit(0);
  }
  
  const pdfPath = args[0];
  const options: Record<string, any> = {};
  let outputFile: string | null = null;
  
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--page':
        const page = parseInt(args[++i] ?? '0', 10);
        options.startPage = page;
        options.endPage = page;
        break;
      case '--start':
        options.startPage = parseInt(args[++i] ?? '1', 10);
        break;
      case '--end':
        options.endPage = parseInt(args[++i] ?? '0', 10);
        break;
      case '--describe':
        options.describeFirst = true;
        break;
      case '--no-formulas':
        options.extractFormulas = false;
        break;
      case '--no-tables':
        options.extractTables = false;
        break;
      case '--no-code':
        options.extractCode = false;
        break;
      case '--force-all':
        options.forceAll = true;
        break;
      case '--output':
        outputFile = args[++i] ?? null;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }
  
  // Check VLM config
  const vlmConfig = getVLMConfig();
  if (!vlmConfig.enabled) {
    console.error('Error: VLM not configured.');
    console.error('Set vlmApiBase and vlmApiKey in ~/.preflight/config.json');
    process.exit(1);
  }
  
  console.log('VLM Extraction');
  console.log('='.repeat(60));
  console.log(`PDF: ${pdfPath}`);
  console.log(`VLM: ${vlmConfig.model} @ ${vlmConfig.apiBase}`);
  console.log('');
  
  try {
    const result = await extractFromPDF(pdfPath, options);
    
    console.log('Results:');
    console.log('-'.repeat(60));
    console.log(`Total pages: ${result.totalPages}`);
    console.log(`Pages processed: ${result.pagesProcessed}`);
    console.log(`VLM API calls: ${result.apiCalls}`);
    console.log('');
    
    const markdown = formatAsMarkdown(result);
    
    if (outputFile) {
      await fs.writeFile(outputFile, markdown, 'utf-8');
      console.log(`Output saved to: ${outputFile}`);
    } else {
      console.log(markdown);
    }
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
