/**
 * Region-based VLM Processing
 *
 * Efficient PDF parsing strategy:
 * 1. Rule-based parsing to detect formula/table regions with coordinates
 * 2. Crop these regions as images
 * 3. Single VLM call to process all regions (LaTeX/Markdown output)
 * 4. Replace region content with VLM results
 *
 * This minimizes VLM calls while ensuring high-quality structured output.
 *
 * @module parser/pdf/region-vlm
 */

import type { AnalyzedElement, VLMConfig, PageStats, TextLine } from './types.js';
import { createModuleLogger } from '../../logging/logger.js';
import { renderPageToBase64, callVLM } from './vlm-fallback.js';

const logger = createModuleLogger('region-vlm');

// ============================================================================
// Types
// ============================================================================

/**
 * A detected region that needs VLM processing.
 */
export interface VLMRegion {
  /** Region type */
  type: 'formula' | 'table';
  /** Page index (0-based) */
  pageIndex: number;
  /** Bounding box in PDF coordinates (origin at bottom-left) */
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Original raw text (for fallback) */
  rawText: string;
  /** Unique ID for matching VLM response */
  id: string;
  /** Confidence of rule-based detection */
  confidence: number;
}

/**
 * VLM batch processing result.
 */
export interface VLMBatchResult {
  /** Region ID -> processed content */
  results: Map<string, string>;
  /** Processing errors */
  errors: string[];
  /** Total processing time in ms */
  processingTimeMs: number;
}

// ============================================================================
// Region Detection Enhancement
// ============================================================================

/**
 * Enhance element detection to include accurate bounds.
 * This wraps the existing detectFormula/detectTable to add bounding boxes.
 */
export function calculateElementBounds(
  lines: TextLine[],
  startIndex: number,
  endIndex: number,
  pageStats: PageStats
): { x: number; y: number; width: number; height: number } {
  const relevantLines = lines.slice(startIndex, endIndex + 1);
  if (relevantLines.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  // Find bounding box from all items in these lines
  let minX = Infinity;
  let maxX = 0;
  let minY = Infinity;
  let maxY = 0;

  for (const line of relevantLines) {
    for (const item of line.items) {
      minX = Math.min(minX, item.x);
      maxX = Math.max(maxX, item.x + item.width);
      // PDF Y is from bottom, but we need to account for font height
      minY = Math.min(minY, item.y - item.height);
      maxY = Math.max(maxY, item.y);
    }
  }

  // Add padding
  const padding = pageStats.medianFontSize * 0.5;

  return {
    x: Math.max(0, minX - padding),
    y: Math.max(0, minY - padding),
    width: Math.min(pageStats.width, maxX - minX + padding * 2),
    height: maxY - minY + padding * 2,
  };
}

/**
 * Collect all regions that need VLM processing from analyzed elements.
 */
export function collectVLMRegions(
  elements: AnalyzedElement[],
  confidenceThreshold = 0.85
): VLMRegion[] {
  const regions: VLMRegion[] = [];
  let regionId = 0;

  for (const element of elements) {
    // Only formula and table need VLM enhancement
    // (code blocks are usually fine with rule-based extraction)
    if (element.type !== 'formula' && element.type !== 'table') {
      continue;
    }

    // Skip if already high confidence (unlikely to improve)
    if (element.confidence >= confidenceThreshold && element.vlmProcessed) {
      continue;
    }

    // Skip if no bounds (shouldn't happen with enhanced detection)
    if (!element.bounds) {
      logger.warn(`Element without bounds: ${element.type} on page ${element.pageIndex}`);
      continue;
    }

    regions.push({
      type: element.type as 'formula' | 'table',
      pageIndex: element.pageIndex,
      bounds: element.bounds,
      rawText: element.content,
      id: `r${regionId++}_p${element.pageIndex}_${element.type}`,
      confidence: element.confidence,
    });
  }

  return regions;
}

// ============================================================================
// Region Cropping
// ============================================================================

/**
 * Crop a region from a PDF page and return as base64 image.
 * 
 * Note: unpdf's renderPageAsImage doesn't support partial rendering,
 * so we render the full page and crop in memory.
 * 
 * @param freshData - Function that returns fresh Uint8Array (unpdf detaches ArrayBuffers)
 */
export async function cropRegionFromPage(
  freshData: () => Uint8Array,
  pageIndex: number,
  bounds: { x: number; y: number; width: number; height: number },
  pageHeight: number,
  scale = 2.0
): Promise<string | null> {
  try {
    // Render full page first (use fresh data to avoid detached ArrayBuffer)
    const fullPageBase64 = await renderPageToBase64(freshData(), pageIndex + 1, scale);
    if (!fullPageBase64) return null;

    // Use sharp or canvas to crop (dynamic import for optional dependency)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sharpModule = await import('sharp' as any) as any;
      const sharp = sharpModule.default || sharpModule;
      
      // Convert PDF coordinates to image coordinates
      // PDF origin is bottom-left, image origin is top-left
      const imgX = Math.round(bounds.x * scale);
      const imgY = Math.round((pageHeight - bounds.y - bounds.height) * scale);
      const imgWidth = Math.round(bounds.width * scale);
      const imgHeight = Math.round(bounds.height * scale);

      const buffer = Buffer.from(fullPageBase64, 'base64');
      const cropped = await sharp(buffer)
        .extract({
          left: Math.max(0, imgX),
          top: Math.max(0, imgY),
          width: Math.max(1, imgWidth),
          height: Math.max(1, imgHeight),
        })
        .png()
        .toBuffer();

      return cropped.toString('base64');
    } catch {
      // sharp not available, return full page
      logger.warn('sharp not available for cropping, using full page image');
      return fullPageBase64;
    }
  } catch (err) {
    logger.error('Failed to crop region:', err instanceof Error ? err : undefined);
    return null;
  }
}

// ============================================================================
// Batch VLM Processing
// ============================================================================

/**
 * Build prompt for batch VLM processing of multiple regions.
 */
function buildBatchPrompt(regions: Array<{ id: string; type: 'formula' | 'table' }>): string {
  const regionDescriptions = regions.map((r, i) => {
    if (r.type === 'formula') {
      return `Image ${i + 1} (ID: ${r.id}): FORMULA - Convert to LaTeX`;
    } else {
      return `Image ${i + 1} (ID: ${r.id}): TABLE - Convert to Markdown`;
    }
  }).join('\n');

  return `Extract content from ${regions.length} PDF regions. Return ONLY JSON.

${regionDescriptions}

Output format:
{"results": [{"id": "...", "content": "..."}]}

RULES:
- FORMULA: Use LaTeX (\\frac, \\sum, ^, _, etc). NO $$ delimiters.
  Example: "\\frac{a}{b} + \\sum_{i=1}^n x_i"
- TABLE: Use Markdown with | and ---
  Example: "|A|B|\\n|---|---|\\n|1|2|"
- Escape backslashes in JSON strings (use \\\\)
- Return valid JSON only`;
}

/**
 * Process multiple regions in a single VLM call.
 * 
 * @param config - VLM configuration
 * @param regionImages - Array of {id, type, imageBase64}
 * @returns Map of region ID to extracted content
 */
export async function batchProcessRegions(
  config: VLMConfig,
  regionImages: Array<{ id: string; type: 'formula' | 'table'; imageBase64: string }>
): Promise<VLMBatchResult> {
  const startTime = Date.now();
  const results = new Map<string, string>();
  const errors: string[] = [];

  if (!config.enabled || regionImages.length === 0) {
    return { results, errors, processingTimeMs: 0 };
  }

  // Build multi-image message content
  const messageContent: Array<{ type: string; image_url?: { url: string }; text?: string }> = [];

  // Add images first
  for (const region of regionImages) {
    messageContent.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${region.imageBase64}` },
    });
  }

  // Add prompt text
  const prompt = buildBatchPrompt(regionImages.map(r => ({ id: r.id, type: r.type })));
  messageContent.push({ type: 'text', text: prompt });

  try {
    const response = await fetch(`${config.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{
          role: 'user',
          content: messageContent,
        }],
        max_tokens: config.maxTokens,  // No limits
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`VLM API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string; code?: string };
      code?: number | string;
      message?: string;
    };

    // Check for various API error formats
    if (data.error) {
      throw new Error(`VLM API error: ${data.error.message || data.error.code || JSON.stringify(data.error)}`);
    }
    
    // Some APIs return error in top-level code/message
    if (data.code && data.code !== 200 && data.code !== '200') {
      throw new Error(`VLM API error code ${data.code}: ${data.message || 'unknown'}`);
    }

    // Validate response structure
    if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
      // Include response preview and key prefix in error for debugging
      const respPreview = JSON.stringify(data).slice(0, 300);
      const keyPrefix = config.apiKey ? config.apiKey.slice(0, 12) : 'NONE';
      throw new Error(`VLM API invalid response (no choices) [key=${keyPrefix}... base=${config.apiBase}]: ${respPreview}`);
    }

    const content = data.choices[0]?.message?.content || '';
    if (!content) {
      throw new Error('VLM API returned empty content');
    }
    
    // Parse JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      let jsonStr = jsonMatch[0];
      let parsed: { results?: Array<{ id: string; content: string }> } | null = null;
      
      // Try direct parsing
      try {
        parsed = JSON.parse(jsonStr) as { results?: Array<{ id: string; content: string }> };
      } catch (firstErr) {
        // Try fixing common issues
        logger.warn(`Initial JSON parse failed for region batch: ${firstErr}`);
        jsonStr = tryFixJson(jsonStr);
        
        try {
          parsed = JSON.parse(jsonStr);
          logger.info('JSON parsing succeeded after fix for region batch');
        } catch (secondErr) {
          // Last resort: try regex extraction of individual results
          logger.warn(`Attempting partial recovery for region batch JSON`);
          const partialResults = recoverRegionBatchJson(jsonStr);
          
          if (partialResults.length > 0) {
            logger.info(`Recovered ${partialResults.length} items from malformed JSON`);
            parsed = { results: partialResults };
          } else {
            logger.error(`All JSON recovery attempts failed for region batch`);
            logger.error(`First error: ${firstErr}`);
            logger.error(`Second error: ${secondErr}`);
            logger.error(`JSON preview (first 300 chars): ${jsonStr.slice(0, 300)}`);
            logger.error(`JSON preview (last 300 chars): ${jsonStr.slice(-300)}`);
            throw new Error(`Failed to parse VLM response: ${secondErr}`);
          }
        }
      }
      
      if (parsed && parsed.results && Array.isArray(parsed.results)) {
        for (const item of parsed.results) {
          if (item.id && item.content) {
            results.set(item.id, item.content);
          }
        }
      }
    } else {
      throw new Error('VLM response did not contain valid JSON');
    }
  } catch (err) {
    // Re-throw all errors - no silent fallback
    throw err;
  }

  logger.info(`Batch VLM processed ${results.size}/${regionImages.length} regions in ${Date.now() - startTime}ms`);

  return {
    results,
    errors,
    processingTimeMs: Date.now() - startTime,
  };
}

// ============================================================================
// Main Processing Pipeline
// ============================================================================

/**
 * Process PDF with region-based VLM enhancement.
 * 
 * Pipeline:
 * 1. Analyze all pages with rule-based detection
 * 2. Collect formula/table regions with bounds
 * 3. Crop regions as images
 * 4. Single VLM call to process all regions
 * 5. Replace region content with VLM results
 * 
 * @param freshData - Function that returns fresh Uint8Array (unpdf detaches ArrayBuffers)
 * @param elements - Pre-analyzed elements from rule-based detection
 * @param pageStats - Page statistics array
 * @param config - VLM configuration
 * @returns Enhanced elements with VLM-processed content
 */
export async function enhanceWithRegionVLM(
  freshData: () => Uint8Array,
  elements: AnalyzedElement[],
  pageStats: PageStats[],
  config: VLMConfig
): Promise<{ elements: AnalyzedElement[]; vlmRegions: number; vlmErrors: string[] }> {
  if (!config.enabled) {
    return { elements, vlmRegions: 0, vlmErrors: [] };
  }

  // Collect regions that need VLM
  const regions = collectVLMRegions(elements);
  
  if (regions.length === 0) {
    logger.info('No regions need VLM processing');
    return { elements, vlmRegions: 0, vlmErrors: [] };
  }

  logger.info(`Found ${regions.length} regions for VLM processing`);

  // Check if sharp is available for cropping
  let sharpAvailable = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await import('sharp' as any);
    sharpAvailable = true;
  } catch {
    // sharp not available
  }

  // If sharp is not available, we can't crop regions efficiently
  // Fall back to per-page VLM processing for unique pages
  if (!sharpAvailable) {
    logger.info('sharp not available, using per-page VLM processing');
    
    // Get unique pages that have regions
    const uniquePages = [...new Set(regions.map(r => r.pageIndex))];
    const maxPages = Math.min(uniquePages.length, 5); // Limit to 5 pages
    const pagesToProcess = uniquePages.slice(0, maxPages);
    
    // Process each page with full-page VLM
    const enhancedElements = [...elements];
    let totalProcessed = 0;
    const allErrors: string[] = [];
    
    for (const pageIdx of pagesToProcess) {
      try {
        const pageElements = await processFullPageVLM(freshData(), pageIdx, config);
        if (pageElements.length > 0) {
          // Replace elements on this page with VLM results
          for (let i = 0; i < enhancedElements.length; i++) {
            if (enhancedElements[i]?.pageIndex === pageIdx && 
                (enhancedElements[i]?.type === 'formula' || enhancedElements[i]?.type === 'table')) {
              // Find matching VLM element by type
              const vlmMatch = pageElements.find(ve => ve.type === enhancedElements[i]?.type);
              if (vlmMatch) {
                enhancedElements[i] = { ...enhancedElements[i]!, ...vlmMatch, vlmProcessed: true };
                totalProcessed++;
              }
            }
          }
        }
      } catch (err) {
        // VLM failure is fatal - throw immediately
        throw new Error(`VLM failed on page ${pageIdx}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    logger.info(`Per-page VLM processed ${totalProcessed} elements across ${pagesToProcess.length} pages`);
    return { elements: enhancedElements, vlmRegions: totalProcessed, vlmErrors: [] };
  }

  // With sharp available, use region cropping
  // No limit - user has unlimited budget
  const MAX_REGIONS = 100;
  const limitedRegions = regions.slice(0, MAX_REGIONS);
  logger.info(`Processing ${limitedRegions.length} regions with cropping (limited from ${regions.length})`);

  // Crop region images
  const regionImages: Array<{ id: string; type: 'formula' | 'table'; imageBase64: string }> = [];

  for (const region of limitedRegions) {
    const stats = pageStats[region.pageIndex];
    if (!stats) continue;

    const imageBase64 = await cropRegionFromPage(
      freshData,
      region.pageIndex,
      region.bounds,
      stats.height
    );

    if (imageBase64) {
      regionImages.push({
        id: region.id,
        type: region.type,
        imageBase64,
      });
    }
  }

  if (regionImages.length === 0) {
    throw new Error('VLM failed: No region images could be cropped');
  }

  // Batch process with VLM
  const vlmResult = await batchProcessRegions(config, regionImages);

  // Create a map from region ID to element index for fast lookup
  const regionToElement = new Map<string, number>();
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el) continue;
    if ((el.type === 'formula' || el.type === 'table') && el.bounds) {
      // Find matching region
      const matchingRegion = regions.find(r => 
        r.pageIndex === el.pageIndex &&
        Math.abs(r.bounds.x - el.bounds!.x) < 1 &&
        Math.abs(r.bounds.y - el.bounds!.y) < 1
      );
      if (matchingRegion) {
        regionToElement.set(matchingRegion.id, i);
      }
    }
  }

  // Update elements with VLM results
  const enhancedElements = [...elements];
  let updatedCount = 0;

  for (const [regionId, content] of vlmResult.results) {
    const elementIndex = regionToElement.get(regionId);
    if (elementIndex !== undefined && enhancedElements[elementIndex]) {
      enhancedElements[elementIndex] = {
        ...enhancedElements[elementIndex]!,
        content,
        vlmProcessed: true,
        confidence: 0.95, // VLM results are high confidence
      };
      updatedCount++;
    }
  }

  logger.info(`Updated ${updatedCount} elements with VLM results`);

  return {
    elements: enhancedElements,
    vlmRegions: regions.length,
    vlmErrors: vlmResult.errors,
  };
}

// ============================================================================
// Inline Formula Detection (Phase 2.5)
// ============================================================================

/**
 * Unicode to LaTeX mapping tables for rule-based conversion.
 */
const UNICODE_TO_LATEX: Record<string, string> = {
  // Greek lowercase
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta',
  'ε': '\\epsilon', 'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta',
  'ι': '\\iota', 'κ': '\\kappa', 'λ': '\\lambda', 'μ': '\\mu',
  'ν': '\\nu', 'ξ': '\\xi', 'ο': 'o', 'π': '\\pi',
  'ρ': '\\rho', 'σ': '\\sigma', 'τ': '\\tau', 'υ': '\\upsilon',
  'φ': '\\phi', 'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
  // Greek uppercase
  'Α': 'A', 'Β': 'B', 'Γ': '\\Gamma', 'Δ': '\\Delta',
  'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Θ': '\\Theta',
  'Ι': 'I', 'Κ': 'K', 'Λ': '\\Lambda', 'Μ': 'M',
  'Ν': 'N', 'Ξ': '\\Xi', 'Ο': 'O', 'Π': '\\Pi',
  'Ρ': 'P', 'Σ': '\\Sigma', 'Τ': 'T', 'Υ': '\\Upsilon',
  'Φ': '\\Phi', 'Χ': 'X', 'Ψ': '\\Psi', 'Ω': '\\Omega',
  // Superscripts
  '⁰': '^0', '¹': '^1', '²': '^2', '³': '^3', '⁴': '^4',
  '⁵': '^5', '⁶': '^6', '⁷': '^7', '⁸': '^8', '⁹': '^9',
  '⁺': '^+', '⁻': '^-', '⁼': '^=', '⁽': '^(', '⁾': '^)',
  'ⁿ': '^n', 'ⁱ': '^i',
  // Subscripts
  '₀': '_0', '₁': '_1', '₂': '_2', '₃': '_3', '₄': '_4',
  '₅': '_5', '₆': '_6', '₇': '_7', '₈': '_8', '₉': '_9',
  '₊': '_+', '₋': '_-', '₌': '_=', '₍': '_(', '₎': '_)',
  'ₐ': '_a', 'ₑ': '_e', 'ₒ': '_o', 'ₓ': '_x', 'ₕ': '_h',
  'ₖ': '_k', 'ₗ': '_l', 'ₘ': '_m', 'ₙ': '_n', 'ₚ': '_p',
  'ₛ': '_s', 'ₜ': '_t',
  // Math operators
  '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint',
  '∂': '\\partial', '∇': '\\nabla', '√': '\\sqrt',
  '∞': '\\infty', '∅': '\\emptyset', '∃': '\\exists', '∀': '\\forall',
  '∈': '\\in', '∉': '\\notin', '∋': '\\ni', '∌': '\\notni',
  '⊂': '\\subset', '⊃': '\\supset', '⊆': '\\subseteq', '⊇': '\\supseteq',
  '∪': '\\cup', '∩': '\\cap', '∧': '\\land', '∨': '\\lor', '¬': '\\neg',
  '×': '\\times', '÷': '\\div', '±': '\\pm', '∓': '\\mp', '·': '\\cdot',
  '≤': '\\le', '≥': '\\ge', '≠': '\\neq', '≈': '\\approx', '≡': '\\equiv',
  '≪': '\\ll', '≫': '\\gg', '∝': '\\propto', '≃': '\\simeq', '≅': '\\cong',
  '⊕': '\\oplus', '⊗': '\\otimes', '⊖': '\\ominus',
  '∘': '\\circ', '•': '\\bullet', '★': '\\star', '⋆': '\\star',
  // Arrows
  '→': '\\rightarrow', '←': '\\leftarrow', '↔': '\\leftrightarrow',
  '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow',
  '↦': '\\mapsto', '↑': '\\uparrow', '↓': '\\downarrow',
  // Misc
  '…': '\\dots', '⋯': '\\cdots', '⋮': '\\vdots', '⋱': '\\ddots',
  '′': "'", '″': "''", '‴': "'''",
  '⟨': '\\langle', '⟩': '\\rangle',
  '⌊': '\\lfloor', '⌋': '\\rfloor', '⌈': '\\lceil', '⌉': '\\rceil',
  'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}', 'ℚ': '\\mathbb{Q}',
  'ℝ': '\\mathbb{R}', 'ℂ': '\\mathbb{C}',
};

/**
 * Mathematical Alphanumeric Symbols (U+1D400-1D7FF) conversion.
 * These are styled variants of letters/digits used in math.
 */
function convertMathAlphanumeric(char: string): string | null {
  const code = char.codePointAt(0);
  if (!code || code < 0x1D400 || code > 0x1D7FF) return null;
  
  // Bold letters: 1D400-1D433 (A-Z), 1D41A-1D433 (a-z)
  if (code >= 0x1D400 && code <= 0x1D419) return String.fromCharCode(65 + code - 0x1D400); // A-Z
  if (code >= 0x1D41A && code <= 0x1D433) return String.fromCharCode(97 + code - 0x1D41A); // a-z
  
  // Italic letters: 1D434-1D467
  if (code >= 0x1D434 && code <= 0x1D44D) return String.fromCharCode(65 + code - 0x1D434);
  if (code >= 0x1D44E && code <= 0x1D467) return String.fromCharCode(97 + code - 0x1D44E);
  
  // Script/calligraphic: 1D49C-1D4CF → \mathcal
  if (code >= 0x1D49C && code <= 0x1D4B5) return `\\mathcal{${String.fromCharCode(65 + code - 0x1D49C)}}`;
  if (code >= 0x1D4B6 && code <= 0x1D4CF) return `\\mathcal{${String.fromCharCode(97 + code - 0x1D4B6)}}`;
  
  // Fraktur: 1D504-1D537 → \mathfrak
  if (code >= 0x1D504 && code <= 0x1D51C) return `\\mathfrak{${String.fromCharCode(65 + code - 0x1D504)}}`;
  if (code >= 0x1D51E && code <= 0x1D537) return `\\mathfrak{${String.fromCharCode(97 + code - 0x1D51E)}}`;
  
  // Double-struck/blackboard: 1D538-1D56B → \mathbb
  if (code >= 0x1D538 && code <= 0x1D550) return `\\mathbb{${String.fromCharCode(65 + code - 0x1D538)}}`;
  if (code >= 0x1D552 && code <= 0x1D56B) return `\\mathbb{${String.fromCharCode(97 + code - 0x1D552)}}`;
  
  // Sans-serif, monospace, etc. - just return plain letter
  // This is a simplified mapping
  const offset = code - 0x1D400;
  const baseOffset = offset % 52;
  if (baseOffset < 26) return String.fromCharCode(65 + baseOffset);
  return String.fromCharCode(97 + baseOffset - 26);
}

/**
 * Convert Unicode math symbols to LaTeX commands (without $ delimiters).
 * This is Phase 2.5a - pure rule-based conversion.
 */
export function unicodeToLatex(text: string): string {
  let result = '';
  
  for (const char of text) {
    // Check direct mapping first
    if (UNICODE_TO_LATEX[char]) {
      result += UNICODE_TO_LATEX[char];
      continue;
    }
    
    // Check math alphanumeric symbols
    const mathAlpha = convertMathAlphanumeric(char);
    if (mathAlpha) {
      result += mathAlpha;
      continue;
    }
    
    // Keep original character
    result += char;
  }
  
  return result;
}

/**
 * Check if a character is part of a math expression.
 */
function isMathChar(char: string): boolean {
  if (!char) return false;
  // LaTeX command start
  if (char === '\\') return true;
  // Subscript/superscript
  if (char === '^' || char === '_') return true;
  // Braces for grouping
  if (char === '{' || char === '}') return true;
  // Math operators and relations
  if ('+-=<>*/|'.includes(char)) return true;
  // Parentheses and brackets in math
  if ('()[]'.includes(char)) return true;
  // Comma in math (e.g., f(x,y))
  if (char === ',') return true;
  // Letters and digits
  if (/[a-zA-Z0-9]/.test(char)) return true;
  // Dots for ellipsis
  if (char === '.') return true;
  return false;
}

/**
 * Detect formula boundaries and wrap with $ delimiters.
 * Improved algorithm that groups related math elements together.
 */
export function addLatexDelimiters(text: string): string {
  // First convert Unicode to LaTeX
  const converted = unicodeToLatex(text);
  
  // Find regions that contain LaTeX commands (\something) or ^/_
  const hasLatex = converted.includes('\\') || converted.includes('^') || converted.includes('_');
  if (!hasLatex) {
    return converted; // No math detected
  }
  
  // Tokenize: split into math regions and text regions
  // Math region: starts with \ or has adjacent ^/_
  const tokens: Array<{ type: 'text' | 'math'; content: string }> = [];
  let i = 0;
  const len = converted.length;
  
  while (i < len) {
    const c = converted[i]!;
    
    // Check if this starts a math region
    const startsWithBackslash = c === '\\';
    const nextIsScript = i + 1 < len && (converted[i + 1] === '^' || converted[i + 1] === '_');
    const isScript = c === '^' || c === '_';
    
    if (startsWithBackslash || nextIsScript || isScript) {
      // Collect the entire math expression
      const mathStart = i;
      
      // If we're at a letter before ^/_, include it
      if (nextIsScript && /[a-zA-Z0-9]/.test(c)) {
        i++;
      }
      
      while (i < len) {
        const curr = converted[i]!;
        
        // LaTeX command
        if (curr === '\\') {
          i++;
          // Consume command name
          while (i < len && /[a-zA-Z]/.test(converted[i]!)) i++;
          // Consume optional {}
          if (i < len && converted[i] === '{') {
            let depth = 1;
            i++;
            while (i < len && depth > 0) {
              if (converted[i] === '{') depth++;
              else if (converted[i] === '}') depth--;
              i++;
            }
          }
          continue;
        }
        
        // Subscript/superscript
        if (curr === '^' || curr === '_') {
          i++;
          if (i < len) {
            if (converted[i] === '{') {
              let depth = 1;
              i++;
              while (i < len && depth > 0) {
                if (converted[i] === '{') depth++;
                else if (converted[i] === '}') depth--;
                i++;
              }
            } else if (/[a-zA-Z0-9+\-]/.test(converted[i]!)) {
              i++;
            }
          }
          continue;
        }
        
        // Math operators - continue if followed by more math
        if ('+-=<>*/'.includes(curr)) {
          const nextNonSpace = findNextNonSpace(converted, i + 1);
          if (nextNonSpace < len && (converted[nextNonSpace] === '\\' || 
              /[a-zA-Z0-9]/.test(converted[nextNonSpace]!))) {
            // Skip to next non-space
            i = nextNonSpace;
            continue;
          }
          // Operator at end - include it
          i++;
          break;
        }
        
        // Letters/digits - continue if followed by ^/_ or more math
        if (/[a-zA-Z0-9]/.test(curr)) {
          i++;
          // Check what follows
          if (i < len) {
            const next = converted[i]!;
            if (next === '^' || next === '_' || next === '\\') {
              continue;
            }
            // Check if it's an operator followed by math
            if ('+-=<>*/'.includes(next)) {
              const afterOp = findNextNonSpace(converted, i + 1);
              if (afterOp < len && (converted[afterOp] === '\\' ||
                  (afterOp + 1 < len && (converted[afterOp + 1] === '^' || converted[afterOp + 1] === '_')) ||
                  /[a-zA-Z0-9]/.test(converted[afterOp]!))) {
                continue;
              }
            }
          }
          break;
        }
        
        // Comma - might be part of a set or function args
        if (curr === ',') {
          const nextNonSpace = findNextNonSpace(converted, i + 1);
          if (nextNonSpace < len && (converted[nextNonSpace] === '\\' ||
              /[a-zA-Z0-9]/.test(converted[nextNonSpace]!))) {
            i = nextNonSpace;
            continue;
          }
          break;
        }
        
        // Brackets and parens - include if balancing
        if ('([{'.includes(curr)) {
          const closeChar = curr === '(' ? ')' : curr === '[' ? ']' : '}';
          let depth = 1;
          const bracketStart = i;
          i++;
          while (i < len && depth > 0) {
            if (converted[i] === curr) depth++;
            else if (converted[i] === closeChar) depth--;
            i++;
          }
          continue;
        }
        
        // Space - check if math continues after
        if (curr === ' ') {
          const nextNonSpace = findNextNonSpace(converted, i);
          if (nextNonSpace < len && (converted[nextNonSpace] === '\\' ||
              (nextNonSpace + 1 < len && (converted[nextNonSpace + 1] === '^' || converted[nextNonSpace + 1] === '_')))) {
            i = nextNonSpace;
            continue;
          }
          break;
        }
        
        // Dots (ellipsis)
        if (curr === '.') {
          // Check for ... pattern
          if (i + 2 < len && converted[i + 1] === '.' && converted[i + 2] === '.') {
            i += 3;
            continue;
          }
          break;
        }
        
        // Other characters - end math region
        break;
      }
      
      const mathContent = converted.slice(mathStart, i).trim();
      if (mathContent) {
        tokens.push({ type: 'math', content: mathContent });
      }
    } else {
      // Text character
      const textStart = i;
      while (i < len) {
        const curr = converted[i]!;
        // Check if math is starting
        if (curr === '\\') break;
        if (i + 1 < len && (converted[i + 1] === '^' || converted[i + 1] === '_')) break;
        if (curr === '^' || curr === '_') break;
        i++;
      }
      const textContent = converted.slice(textStart, i);
      if (textContent) {
        tokens.push({ type: 'text', content: textContent });
      }
    }
  }
  
  // Reconstruct with $ delimiters
  return tokens.map(t => t.type === 'math' ? `$${t.content}$` : t.content).join('');
}

/**
 * Find next non-space character index.
 */
function findNextNonSpace(str: string, start: number): number {
  let i = start;
  while (i < str.length && str[i] === ' ') i++;
  return i;
}

/**
 * Unicode math symbols and patterns that indicate inline formulas.
 */
const UNICODE_MATH_PATTERNS = [
  // Greek letters (commonly used in math)
  /[\u0391-\u03C9]/,  // Α-ω
  // Math operators and symbols
  /[\u2200-\u22FF]/,  // Mathematical Operators block (∀∃∅∇∈∉⊂⊃∪∩∧∨...)
  // Superscripts and subscripts
  /[\u2070-\u209F]/,  // Superscripts and Subscripts (⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ₀₁₂...)
  // Mathematical Alphanumeric Symbols (bold/italic math letters)
  /[\u{1D400}-\u{1D7FF}]/u,  // 𝐀-𝟿 (math bold, italic, script, etc.)
  // Arrows
  /[\u2190-\u21FF]/,  // Arrows block (←↑→↓↔↕...)
  // Miscellaneous Mathematical Symbols
  /[\u27C0-\u27EF]/,  // Misc Math Symbols-A
  /[\u2980-\u29FF]/,  // Misc Math Symbols-B
  // Number forms and fractions
  /[\u2150-\u218F]/,  // Number Forms (⅓⅔¼¾...)
  // Common inline patterns: x², y₁, etc.
  /[a-zA-Z][\u2070-\u209F]/,  // letter followed by superscript/subscript
];

/**
 * Check if a text contains Unicode math symbols suggesting inline formulas.
 * Returns true if the text likely contains formulas that need LaTeX conversion.
 */
export function containsUnicodeMath(text: string): boolean {
  if (!text || text.length < 3) return false;
  
  // Check against all patterns
  for (const pattern of UNICODE_MATH_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  
  // Additional heuristics for common formula patterns
  // Consecutive math-like characters (e.g., "x²+y²")
  if (/[a-zA-Z][²³⁴⁵⁶⁷⁸⁹⁺⁻⁼]/.test(text)) return true;
  if (/[₀-₉]+/.test(text)) return true;  // Subscript numbers
  
  return false;
}

/**
 * Find paragraphs that contain Unicode math symbols and need VLM processing.
 */
export function findParagraphsWithInlineFormulas(
  elements: AnalyzedElement[]
): { element: AnalyzedElement; index: number }[] {
  const results: { element: AnalyzedElement; index: number }[] = [];
  
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el) continue;
    
    // Only process paragraphs and headings (not already-processed formulas)
    if (el.type !== 'paragraph' && el.type !== 'heading') continue;
    
    // Skip if already VLM processed
    if (el.vlmProcessed) continue;
    
    // Check for Unicode math
    if (containsUnicodeMath(el.content)) {
      results.push({ element: el, index: i });
    }
  }
  
  return results;
}

/**
 * Try to fix common JSON issues in VLM responses.
 */
function tryFixJson(jsonStr: string): string {
  let fixed = jsonStr;
  
  // First: minify JSON by removing whitespace between structural elements
  // This handles VLM-formatted JSON with pretty-printing
  // But preserve whitespace inside string values
  let inString = false;
  let escaped = false;
  const chars: string[] = [];
  
  for (let i = 0; i < fixed.length; i++) {
    const char = fixed[i];
    if (!char) continue;  // Skip undefined
    
    if (escaped) {
      chars.push(char);
      escaped = false;
      continue;
    }
    
    if (char === '\\' && inString) {
      escaped = true;
      chars.push(char);
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      chars.push(char);
      continue;
    }
    
    if (inString) {
      // Inside string: keep everything
      chars.push(char);
    } else {
      // Outside string: remove unnecessary whitespace
      if (char === ' ' || char === '\n' || char === '\r' || char === '\t') {
        // Skip whitespace outside strings
        continue;
      }
      chars.push(char);
    }
  }
  
  fixed = chars.join('');
  
  // Remove trailing commas before ] or }
  fixed = fixed.replace(/,([\]\}])/g, '$1');
  
  // Fix unescaped newlines in strings (shouldn't happen after minify, but just in case)
  fixed = fixed.replace(/"([^"]*?)\n([^"]*?)"/g, (_, p1, p2) => {
    return `"${p1}\\n${p2}"`;
  });
  
  // Fix unescaped tabs
  fixed = fixed.replace(/"([^"]*?)\t([^"]*?)"/g, (_, p1, p2) => {
    return `"${p1}\\t${p2}"`;
  });
  
  // Fix unescaped backslashes that are not valid escape sequences
  // Common: VLM returns \alpha instead of \\alpha
  fixed = fixed.replace(/\\(?!["\\nrtbfu\/])/g, '\\\\');
  
  // Remove control characters
  fixed = fixed.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  
  // Fix truncated JSON - try to close unclosed brackets/braces
  const openBraces = (fixed.match(/\{/g) || []).length;
  const closeBraces = (fixed.match(/\}/g) || []).length;
  const openBrackets = (fixed.match(/\[/g) || []).length;
  const closeBrackets = (fixed.match(/\]/g) || []).length;
  
  // Add missing closing brackets/braces
  for (let i = 0; i < openBrackets - closeBrackets; i++) {
    fixed += ']';
  }
  for (let i = 0; i < openBraces - closeBraces; i++) {
    fixed += '}';
  }
  
  // Fix unclosed strings at end (truncated response)
  const quoteCount = (fixed.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    // Add closing quote
    fixed += '"';
    // And likely need to close the structure
    if (openBraces > closeBraces) fixed += '}';
    if (openBrackets > closeBrackets) fixed += ']';
  }
  
  return fixed;
}

/**
 * Aggressively recover truncated/malformed JSON from VLM responses.
 * Attempts to extract valid items even if the JSON is incomplete.
 */
function recoverPartialJson(jsonStr: string): { r?: Array<{ i: number; t: string }> } {
  // Try to extract individual items from truncated JSON
  // Look for patterns like {"i":1,"t":"..."} even if the outer structure is broken
  const items: Array<{ i: number; t: string }> = [];
  
  // Match individual item objects
  const itemPattern = /\{\s*"i"\s*:\s*(\d+)\s*,\s*"t"\s*:\s*"([^"]*(?:\\.[^"]*)*)"\s*\}/g;
  let match;
  
  while ((match = itemPattern.exec(jsonStr)) !== null) {
    const i = parseInt(match[1] || '0', 10);
    const t = match[2] || '';
    if (i > 0 && t) {
      items.push({ i, t });
    }
  }
  
  // Also try compact format variations
  const compactPattern = /"i"\s*:\s*(\d+)\s*,\s*"t"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/g;
  while ((match = compactPattern.exec(jsonStr)) !== null) {
    const i = parseInt(match[1] || '0', 10);
    const t = match[2] || '';
    if (i > 0 && t && !items.some(item => item.i === i)) {
      items.push({ i, t });
    }
  }
  
  return items.length > 0 ? { r: items } : {};
}

/**
 * Recover region batch JSON with format: {"results": [{"id": "...", "content": "..."}]}
 * Similar to recoverPartialJson but for region batch format.
 */
function recoverRegionBatchJson(jsonStr: string): Array<{ id: string; content: string }> {
  const results: Array<{ id: string; content: string }> = [];
  
  // Match individual result objects - handle multi-line content
  const resultPattern = /\{\s*"id"\s*:\s*"([^"]+)"\s*,\s*"content"\s*:\s*"([^"]*(?:\\.[^"]*)*)"\s*\}/g;
  let match;
  
  while ((match = resultPattern.exec(jsonStr)) !== null) {
    const id = match[1];
    const content = match[2];
    if (id && content) {
      results.push({ id, content });
    }
  }
  
  // Also try less strict patterns for truncated content
  if (results.length === 0) {
    const loosePattern = /"id"\s*:\s*"([^"]+)"\s*,\s*"content"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/g;
    while ((match = loosePattern.exec(jsonStr)) !== null) {
      const id = match[1];
      const content = match[2];
      if (id && content && !results.some(r => r.id === id)) {
        results.push({ id, content });
      }
    }
  }
  
  return results;
}

/**
 * Check if rule-based conversion produced valid LaTeX.
 * Returns true if the result looks reasonable (has balanced $ and proper commands).
 */
function isValidRuleConversion(original: string, converted: string): boolean {
  // Must have changed something
  if (original === converted) return false;
  
  // Must have $ delimiters for math
  if (!converted.includes('$')) return false;
  
  // Check balanced $ (simple check - count should be even)
  const dollarCount = (converted.match(/\$/g) || []).length;
  if (dollarCount % 2 !== 0) return false;
  
  // Check no orphaned LaTeX commands outside $
  // Split by $ and check odd segments (outside math) don't have \\
  const segments = converted.split('$');
  for (let i = 0; i < segments.length; i += 2) {
    if (segments[i]?.includes('\\')) return false;
  }
  
  return true;
}

/**
 * Process paragraphs with inline formulas.
 * Strategy:
 * 1. First try pure rule-based conversion (no VLM call)
 * 2. If rule-based fails or produces bad output, fall back to VLM
 * 
 * This minimizes VLM calls while ensuring quality.
 */
export async function enhanceInlineFormulas(
  elements: AnalyzedElement[],
  config: VLMConfig
): Promise<{ elements: AnalyzedElement[]; enhanced: number }> {
  const paragraphsToProcess = findParagraphsWithInlineFormulas(elements);
  
  if (paragraphsToProcess.length === 0) {
    logger.info('No paragraphs with inline formulas found');
    return { elements, enhanced: 0 };
  }
  
  logger.info(`Found ${paragraphsToProcess.length} paragraphs with potential inline formulas`);
  
  const enhancedElements = [...elements];
  let ruleConverted = 0;
  let vlmConverted = 0;
  const needsVLM: { element: AnalyzedElement; index: number }[] = [];
  
  // Phase 2.5a: Try rule-based conversion first
  for (const item of paragraphsToProcess) {
    const original = item.element.content;
    const converted = addLatexDelimiters(original);
    
    if (isValidRuleConversion(original, converted)) {
      // Rule-based conversion succeeded
      enhancedElements[item.index] = {
        ...enhancedElements[item.index]!,
        content: converted,
        vlmProcessed: false, // Mark as rule-processed, not VLM
      };
      ruleConverted++;
    } else {
      // Need VLM for this one
      needsVLM.push(item);
    }
  }
  
  logger.info(`Rule-based conversion: ${ruleConverted} succeeded, ${needsVLM.length} need VLM`);
  
  // Phase 2.5b: Use VLM for remaining items (if enabled and there are items)
  if (config.enabled && needsVLM.length > 0) {
    const BATCH_SIZE = 5;  // Reduced from 10 to minimize JSON corruption risk
    const MAX_BATCHES = 2; // Reduced from 3 to limit VLM calls
    
    const batches = [];
    for (let i = 0; i < needsVLM.length && batches.length < MAX_BATCHES; i += BATCH_SIZE) {
      batches.push(needsVLM.slice(i, i + BATCH_SIZE));
    }
    
    for (const batch of batches) {
      try {
        const enhanced = await processInlineFormulaBatch(batch, config);
        
        for (const result of enhanced) {
          if (result.text) {
            enhancedElements[result.elementIndex] = {
              ...enhancedElements[result.elementIndex]!,
              content: result.text,
              vlmProcessed: true,
            };
            vlmConverted++;
          }
        }
      } catch (err) {
        logger.warn(`Batch VLM enhancement failed: ${err instanceof Error ? err.message : String(err)}`);
        // Fall back to rule conversion for failed items
        for (const item of batch) {
          const converted = addLatexDelimiters(item.element.content);
          if (converted !== item.element.content) {
            enhancedElements[item.index] = {
              ...enhancedElements[item.index]!,
              content: converted,
              vlmProcessed: false,
            };
            ruleConverted++;
          }
        }
      }
    }
  } else if (needsVLM.length > 0) {
    // VLM not enabled - use rule conversion as fallback anyway
    for (const item of needsVLM) {
      const converted = addLatexDelimiters(item.element.content);
      if (converted !== item.element.content) {
        enhancedElements[item.index] = {
          ...enhancedElements[item.index]!,
          content: converted,
          vlmProcessed: false,
        };
        ruleConverted++;
      }
    }
  }
  
  const total = ruleConverted + vlmConverted;
  if (total > 0) {
    logger.info(`Enhanced ${total} paragraphs (${ruleConverted} by rules, ${vlmConverted} by VLM)`);
  }
  
  return { elements: enhancedElements, enhanced: total };
}

/**
 * Process a single batch of paragraphs for inline formula conversion using VLM.
 * VLM task is simplified: text is already pre-converted, just need to fix boundaries.
 */
async function processInlineFormulaBatch(
  batch: { element: AnalyzedElement; index: number }[],
  config: VLMConfig
): Promise<Array<{ elementIndex: number; text: string }>> {
  // Pre-convert with rules, then ask VLM to fix boundaries
  const preConverted = batch.map((p, i) => {
    const converted = unicodeToLatex(p.element.content);
    return `[${i + 1}] ${converted.slice(0, 500)}`;
  }).join('\n');
  
  const prompt = `Add $ delimiters around math formulas. Return JSON only.

Input (LaTeX commands without delimiters):
${preConverted}

Output: {"r":[{"i":1,"t":"text with $math$ delimiters"}]}

Rules:
- Wrap LaTeX commands (\\alpha, \\sum, etc.) and math (x^2, a_1) with $...$
- Keep non-math text unchanged
- Example: "where \\alpha \\in [0,1]" → "where $\\alpha \\in [0,1]$"`;

  const response = await fetch(`${config.apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2048,  // Reduced from 4096 to prevent JSON truncation
      temperature: 0,     // Use deterministic output for JSON
    }),
  });

  if (!response.ok) {
    throw new Error(`VLM API error: ${response.status}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(`VLM API error: ${data.error.message}`);
  }

  const content = data.choices?.[0]?.message?.content || '';
  if (!content) {
    logger.warn('VLM returned empty content for inline formulas');
    return [];
  }

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn('No JSON found in VLM response for inline formulas');
    return [];
  }

  let jsonStr = jsonMatch[0];
  
  // Try parsing, with fallback to fixed version
  let parsed: { r?: Array<{ i: number; t: string }>; results?: Array<{ index: number; text: string }> };
  try {
    parsed = JSON.parse(jsonStr);
  } catch (firstErr) {
    // Try fixing common issues
    logger.warn(`Initial JSON parse failed: ${firstErr instanceof Error ? firstErr.message : String(firstErr)}`);
    const originalLength = jsonStr.length;
    jsonStr = tryFixJson(jsonStr);
    logger.info(`JSON fix applied, length: ${originalLength} -> ${jsonStr.length}`);
    
    try {
      parsed = JSON.parse(jsonStr);
      logger.info('JSON parsing succeeded after fix');
    } catch (secondErr) {
      logger.warn(`Standard JSON fix failed, attempting partial recovery`);
      logger.warn(`Original error: ${firstErr instanceof Error ? firstErr.message : String(firstErr)}`);
      logger.warn(`After fix error: ${secondErr instanceof Error ? secondErr.message : String(secondErr)}`);
      
      // Last resort: try to extract partial data
      const recovered = recoverPartialJson(jsonStr);
      if (recovered.r && recovered.r.length > 0) {
        logger.info(`Recovered ${recovered.r.length} items from malformed JSON`);
        parsed = recovered;
      } else {
        logger.error(`All JSON recovery attempts failed`);
        logger.error(`JSON preview (first 200 chars): ${jsonStr.slice(0, 200)}`);
        logger.error(`JSON preview (last 200 chars): ${jsonStr.slice(-200)}`);
        return [];
      }
    }
  }

  // Support both compact (r/i/t) and verbose (results/index/text) formats
  const results: Array<{ elementIndex: number; text: string }> = [];
  
  const items = parsed.r || parsed.results || [];
  for (const item of items) {
    const idx = (item as { i?: number; index?: number }).i ?? (item as { index?: number }).index;
    const text = (item as { t?: string; text?: string }).t ?? (item as { text?: string }).text;
    
    if (idx !== undefined && text && idx >= 1 && idx <= batch.length) {
      const batchItem = batch[idx - 1];
      if (batchItem) {
        results.push({ elementIndex: batchItem.index, text });
      }
    }
  }
  
  return results;
}

// ============================================================================
// Full Page VLM Processing
// ============================================================================

/**
 * Simplified single-call VLM processing for a full page.
 * Use this when cropping is not available or for complex pages.
 */
export async function processFullPageVLM(
  pdfData: Uint8Array,
  pageIndex: number,
  config: VLMConfig
): Promise<AnalyzedElement[]> {
  if (!config.enabled) return [];

  const imageBase64 = await renderPageToBase64(pdfData, pageIndex + 1);
  if (!imageBase64) return [];

  const prompt = `Extract structured content from this PDF page. Return ONLY a JSON object.

Output format:
{"elements": [{"type": "...", "content": "..."}]}

Element types:
- heading: {"type":"heading", "content":"Title", "level":1}
- paragraph: {"type":"paragraph", "content":"Text..."}
- formula: {"type":"formula", "content":"\\\\frac{a}{b}"} (LaTeX, no $$ delimiters)
- table: {"type":"table", "content":"|A|B|\\n|---|---|\\n|1|2|"} (Markdown)
- code: {"type":"code", "content":"code...", "language":"python"}
- list: {"type":"list", "content":"- item1\\n- item2"}

CRITICAL RULES:
1. For formulas: Convert ALL math to LaTeX. Use \\frac, \\sum, \\int, ^, _, etc.
2. For tables: Use proper Markdown table syntax with | and ---
3. Return VALID JSON only. Escape special characters in strings.
4. Maintain reading order from top to bottom.`;

  try {
    const response = await callVLM(config, imageBase64, prompt);
    
    // Try to extract JSON, handling potential markdown code blocks
    let jsonStr = response;
    const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1] ?? '';
    } else {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }
    }
    
    if (!jsonStr.trim().startsWith('{')) {
      logger.warn(`VLM response is not JSON for page ${pageIndex}`);
      return [];
    }
    
    const parsed = JSON.parse(jsonStr) as {
      elements?: Array<{
        type: string;
        content: string;
        level?: number;
        language?: string;
      }>;
    };

    if (!parsed.elements || !Array.isArray(parsed.elements)) {
      logger.warn(`VLM response missing elements array for page ${pageIndex}`);
      return [];
    }

    return parsed.elements
      .filter(el => el && el.type && el.content)
      .map(el => ({
        type: el.type as AnalyzedElement['type'],
        content: el.content,
        confidence: 0.9,
        pageIndex,
        level: el.level,
        vlmProcessed: true,
      }));
  } catch (err) {
    logger.error(`Full page VLM failed for page ${pageIndex}:`, err instanceof Error ? err : undefined);
    return [];
  }
}
