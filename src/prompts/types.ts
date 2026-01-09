/**
 * Prompt template types.
 */
export interface PromptTemplate {
  /** Template name */
  name: string;
  /** Template string with placeholders */
  template: string;
}

export interface PromptInput {
  [key: string]: string | number | boolean | undefined;
}