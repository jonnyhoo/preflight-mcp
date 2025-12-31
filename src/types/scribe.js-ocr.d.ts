/**
 * Type declarations for scribe.js-ocr module.
 */
declare module 'scribe.js-ocr' {
  /**
   * Extract text from one or more images using OCR.
   * @param images Array of image sources (URLs, file paths, or data URIs)
   * @returns Promise resolving to extracted text
   */
  export function extractText(images: (string | ArrayBuffer)[]): Promise<string>;
  
  /**
   * Default export with extractText function
   */
  const scribe: {
    extractText: typeof extractText;
  };
  
  export default scribe;
}
