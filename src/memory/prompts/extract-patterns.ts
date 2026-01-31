/**
 * Prompts for pattern extraction from memory contents
 * @module memory/prompts/extract-patterns
 */

export const EXTRACT_PATTERNS_SYSTEM_PROMPT = `You are a behavioral pattern analyst. Identify consistent patterns in user behavior, preferences, and workflows from the provided memories. Respond with valid JSON only.`;

export const EXTRACT_PATTERNS_PROMPT = `
You are a behavioral pattern analyst. Analyze semantic memories to identify user habits and patterns.
<memories>
{semantic_memories}
</memories>
Identify patterns in these categories:
- coding_style: language preferences, naming conventions, architectural preferences
- communication: tone, verbosity, response format preferences
- tool_usage: preferred tools, commands, workflows
- workflow: problem-solving approaches, research patterns, debugging habits
- knowledge_domains: topics of interest, expertise areas, learning preferences

Output JSON format:
{
  "patterns": [
    {
      "content": "User prefers functional programming patterns in TypeScript",
      "type": "preference" | "habit" | "pattern",
      "category": "coding_style",
      "confidence": 0.0-1.0,
      "occurrenceCount": 3,
      "evidenceIds": ["sem_xxx", "sem_yyy"],
      "abstractionLevel": "shallow" | "intermediate" | "deep",
      "shouldStore": true,
      "sensitive": false
    }
  ]
}

Rules:
- confidence = occurrenceCount / totalMemoriesAnalyzed (with higher weight for recent memories)
- Only extract patterns appearing in 2+ memories or with strong evidence
- abstractionLevel: shallow (surface-level observation), intermediate (behavioral pattern), deep (core personality/trait)
- Set shouldStore: false for patterns that seem temporary or situational
- Set sensitive: true if contains personal information
- Focus on consistent, recurring behaviors rather than one-off mentions
- For patterns, emphasize evidence from multiple sources
- Use occurrenceCount to indicate how frequently the pattern was observed
`;