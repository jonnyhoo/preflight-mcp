/**
 * Debug VLM JSON response parsing
 */
import { getConfig } from './src/config.ts';
import { renderPageToBase64, callVLM, createVLMConfig } from './src/parser/pdf/vlm-fallback.ts';
import * as fs from 'fs';

async function main() {
  const pdfPath = 'E:\\coding\\论文\\DynaDebate.pdf';
  const config = getConfig();
  
  // Create VLM config from preflight config
  const vlmConfig = createVLMConfig({
    apiBase: config.vlmApiBase,
    apiKey: config.vlmApiKey,
    model: config.vlmModel,
    enabled: config.vlmEnabled,
  });
  
  console.log('VLM Config:', {
    enabled: vlmConfig.enabled,
    hasApiKey: !!vlmConfig.apiKey,
    hasApiBase: !!vlmConfig.apiBase,
    model: vlmConfig.model,
  });
  
  console.log('Reading PDF...');
  const buffer = fs.readFileSync(pdfPath);
  const pdfData = new Uint8Array(buffer);
  
  console.log('Rendering page 1...');
  const imageBase64 = await renderPageToBase64(pdfData, 1);
  if (!imageBase64) {
    console.error('Failed to render page - check @napi-rs/canvas installation');
    return;
  }
  console.log('Rendered, base64 length:', imageBase64.length);
  
  const prompt = `Analyze this PDF page and extract ALL structured content.
Output JSON with elements array:
{
  "elements": [
    {"type": "heading", "content": "...", "level": 1},
    {"type": "paragraph", "content": "..."},
    {"type": "formula", "content": "LaTeX without $$"},
    {"type": "table", "content": "| col1 | col2 |\\n|---|---|\\n| a | b |"},
    {"type": "code", "content": "code text", "language": "python"},
    {"type": "list", "content": "- item1\\n- item2"}
  ]
}

Rules:
- Formulas: Use LaTeX syntax
- Tables: Use Markdown format
- Preserve all text content
- Maintain reading order`;

  console.log('Calling VLM...');
  const response = await callVLM(vlmConfig, imageBase64, prompt);
  
  console.log('\n=== RAW VLM RESPONSE ===');
  console.log(response);
  console.log('\n=== END RAW RESPONSE ===\n');
  
  // Try to extract JSON
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    console.log('\n=== EXTRACTED JSON ===');
    console.log(jsonMatch[0]);
    console.log('\n=== ATTEMPTING PARSE ===');
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('Parse SUCCESS!');
      console.log('Elements count:', parsed.elements?.length);
    } catch (err) {
      console.log('Parse FAILED:', err);
      // Show around position 2312
      const pos = 2312;
      console.log(`\nContent around position ${pos}:`);
      console.log(jsonMatch[0].slice(Math.max(0, pos - 50), pos + 50));
    }
  } else {
    console.log('No JSON found in response');
  }
}

main().catch(console.error);
