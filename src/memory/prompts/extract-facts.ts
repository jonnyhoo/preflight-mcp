/**
 * Prompts for fact extraction from memory contents
 * @module memory/prompts/extract-facts
 */

export const EXTRACT_FACTS_SYSTEM_PROMPT = `You are an information extraction assistant. Extract structured facts from the provided content. Respond with valid JSON only.`;

export const EXTRACT_FACTS_PROMPT = `
You are an information extraction assistant. Extract structured facts from the conversation.
<conversation>
{content}
</conversation>
Extract:
1. Entities: person names, organizations, products, concepts
2. Relations: (subject, predicate, object) triples
3. User preferences: explicit likes/dislikes, coding styles, tool preferences
4. Technical facts: programming languages, frameworks, tools, concepts mentioned

Output JSON format:
{
  "facts": [
    {
      "content": "User prefers TypeScript over JavaScript for new projects",
      "type": "preference" | "fact" | "relation" | "entity",
      "confidence": 0.0-1.0,
      "evidenceEpisodeIds": ["memory_id1", "memory_id2"],
      "shouldStore": true,
      "sensitive": false,
      "subject"?: "TypeScript",
      "predicate"?: "preferred_over",
      "object"?: "JavaScript",
      "category"?: "coding_style" | "tool_preference" | "technical_knowledge" | etc
    }
  ]
}

Rules:
- confidence: 0.0-1.0 based on clarity and certainty of the fact
- Only extract explicitly stated or strongly implied facts
- Set sensitive: true if contains API keys/passwords or personal information
- Set shouldStore: false if uncertain or potentially not worth storing long-term
- Prefer extracting user preferences and technical knowledge over general facts
- For preferences, use category "preference" or subcategories like "coding_style", "tool_usage"
- For technical facts, use category "technical_knowledge" or "domain_knowledge"
- For relations, populate subject/predicate/object fields
`;