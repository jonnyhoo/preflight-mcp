/**
 * Type declarations for scribe.js-ocr module.
 * 
 * Scribe.js is a JavaScript library that performs OCR and extracts text from
 * images and PDFs. It supports:
 * - Recognizing text from images
 * - Extracting text from PDF files (both text-native and image-native)
 * - Adding invisible text layers to PDFs
 */
declare module 'scribe.js-ocr' {
  /**
   * Scribe.js initialization options.
   */
  export interface InitOptions {
    /** Enable verbose logging */
    verbose?: boolean;
    /** OCR engine mode: 'quality' (default) or 'speed' */
    ocrMode?: 'quality' | 'speed';
    /** Languages for OCR (default: ['eng']) */
    languages?: string[];
  }

  /**
   * Options for text extraction.
   */
  export interface ExtractOptions {
    /** For PDFs: whether to prefer native text extraction over OCR */
    preferNativeText?: boolean;
    /** Maximum pages to process (default: all) */
    maxPages?: number;
    /** Page range to process (1-indexed) */
    pageRange?: { start: number; end: number };
  }

  /**
   * Initialize Scribe.js engine.
   * @param options Initialization options
   */
  export function init(options?: InitOptions): Promise<void>;

  /**
   * Extract text from images or PDFs using OCR.
   * 
   * @param inputs Array of input sources:
   *   - File paths (string)
   *   - URLs (string starting with http:// or https://)
   *   - Data URIs (string starting with data:)
   *   - ArrayBuffer containing file data
   * @param options Extraction options
   * @returns Promise resolving to extracted text
   * 
   * @remarks
   * For PDF files:
   * - If the PDF is text-native, Scribe.js extracts existing text directly
   * - If the PDF is image-native (scanned), Scribe.js performs OCR
   * - This is automatically detected and handled
   */
  export function extractText(
    inputs: (string | ArrayBuffer)[],
    options?: ExtractOptions
  ): Promise<string>;

  /**
   * Terminate Scribe.js engine and free resources.
   */
  export function terminate(): Promise<void>;

  /**
   * Check if Scribe.js is initialized and ready.
   */
  export function isReady(): boolean;

  /**
   * Default export with all functions.
   */
  const scribe: {
    init: typeof init;
    extractText: typeof extractText;
    terminate: typeof terminate;
    isReady: typeof isReady;
  };

  export default scribe;
}
