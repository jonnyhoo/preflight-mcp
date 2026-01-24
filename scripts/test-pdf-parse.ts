/**
 * Debug script to test PDF parsing with vlmParser=true
 * Run: npx tsx scripts/test-pdf-parse.ts <pdf-path>
 */
import { ingestDocument } from '../src/bundle/document-ingest.ts';
import { getConfig } from '../src/config.ts';

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Usage: npx tsx scripts/test-pdf-parse.ts <pdf-path>');
    process.exit(1);
  }
  
  console.log('Loading config...');
  const config = getConfig();
  console.log('VLM config from loaded config:', {
    vlmEnabled: config.vlmEnabled,
    hasApiKey: !!config.vlmApiKey,
    hasApiBase: !!config.vlmApiBase,
    vlmModel: config.vlmModel,
  });
  
  const hasVlmConfig = config.vlmEnabled && config.vlmApiKey && config.vlmApiBase;
  console.log('hasVlmConfig:', hasVlmConfig);
  
  console.log('\n--- Testing with vlmParser=true ---');
  const result = await ingestDocument(pdfPath, {
    extractImages: true,
    extractTables: true,
    extractEquations: true,
    vlmParser: true,
    vlmConfig: hasVlmConfig ? {
      apiBase: config.vlmApiBase!,
      apiKey: config.vlmApiKey!,
      model: config.vlmModel,
    } : undefined,
  });
  
  console.log('\n--- Result ---');
  console.log('Success:', result.success);
  console.log('Parser used:', result.parserUsed);
  console.log('Warnings:', result.warnings);
  console.log('Error:', result.error);
  console.log('Full text length:', result.fullText?.length ?? 0);
  
  // Show first 3000 chars of fullText to check quality
  console.log('\n--- Full Text Sample (first 3000 chars) ---');
  console.log(result.fullText?.slice(0, 3000) ?? 'No fullText');
  
  // Check for LaTeX markers
  const hasLatex = result.fullText?.includes('$$') || result.fullText?.includes('\\frac');
  console.log('\n--- Quality Check ---');
  console.log('Has LaTeX formulas:', hasLatex);
  console.log('Has Markdown headings:', result.fullText?.includes('# '));
}

main().catch(console.error);
