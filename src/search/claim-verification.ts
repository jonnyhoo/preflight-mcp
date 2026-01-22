/**
 * Claim Verification
 *
 * Functions for verifying claims against the search index with
 * evidence classification and confidence scoring.
 *
 * @module search/claim-verification
 */
import type { SearchHit, SearchScope } from './types.js';
import { searchIndex, tokenizeForSafeQuery } from './sqliteFts.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Evidence classification based on content analysis.
 */
export type EvidenceType = 'supporting' | 'contradicting' | 'related';

/**
 * A piece of evidence with classification and relevance score.
 */
export type EvidenceHit = SearchHit & {
  evidenceType: EvidenceType;
  relevanceScore: number; // 0-1, higher = more relevant
};

/**
 * Result of claim verification.
 */
export type VerificationResult = {
  claim: string;
  found: boolean;
  confidence: number; // 0-1, overall confidence in verification
  confidenceLabel: 'high' | 'medium' | 'low' | 'none';
  summary: string;
  supporting: EvidenceHit[];
  contradicting: EvidenceHit[];
  related: EvidenceHit[];
};

// ============================================================================
// Pattern Constants
// ============================================================================

// Negation patterns that might indicate contradiction
const NEGATION_PATTERNS = [
  /\b(not|no|never|cannot|can't|won't|doesn't|don't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't)\b/i,
  /\b(deprecated|removed|obsolete|discontinued|unsupported|disabled)\b/i,
  /\b(instead of|rather than|unlike|contrary to|in contrast)\b/i,
];

// Affirmation patterns that might indicate support
const AFFIRMATION_PATTERNS = [
  /\b(is|are|was|were|has|have|does|do|can|will|should|must)\b/i,
  /\b(supports?|enables?|provides?|allows?|includes?)\b/i,
  /\b(recommended|required|default|standard|official)\b/i,
];

// ============================================================================
// Internal Functions
// ============================================================================

/**
 * Classify evidence as supporting, contradicting, or related.
 * Uses heuristic analysis of content patterns.
 */
function classifyEvidence(snippet: string, claimTokens: string[]): { type: EvidenceType; score: number } {
  const lowerSnippet = snippet.toLowerCase();
  
  // Count how many claim tokens appear in the snippet
  const tokenMatches = claimTokens.filter(t => lowerSnippet.includes(t.toLowerCase())).length;
  const tokenRatio = claimTokens.length > 0 ? tokenMatches / claimTokens.length : 0;
  
  // Check for negation patterns
  const hasNegation = NEGATION_PATTERNS.some(p => p.test(snippet));
  
  // Check for affirmation patterns
  const hasAffirmation = AFFIRMATION_PATTERNS.some(p => p.test(snippet));
  
  // Base score on token match ratio
  let score = tokenRatio * 0.7 + 0.3; // 0.3-1.0 range
  
  // Classify based on patterns
  let type: EvidenceType;
  
  if (tokenRatio >= 0.5) {
    // High token match - likely directly relevant
    if (hasNegation && !hasAffirmation) {
      type = 'contradicting';
      score *= 0.9; // Slightly lower confidence for contradictions
    } else if (hasAffirmation || !hasNegation) {
      type = 'supporting';
    } else {
      type = 'related';
      score *= 0.8;
    }
  } else if (tokenRatio >= 0.25) {
    // Moderate token match - probably related
    type = 'related';
    score *= 0.7;
  } else {
    // Low token match - tangentially related
    type = 'related';
    score *= 0.5;
  }
  
  return { type, score: Math.min(1, Math.max(0, score)) };
}

/**
 * Calculate overall confidence based on evidence distribution.
 */
function calculateConfidence(supporting: EvidenceHit[], contradicting: EvidenceHit[], related: EvidenceHit[]): {
  confidence: number;
  label: 'high' | 'medium' | 'low' | 'none';
} {
  const totalEvidence = supporting.length + contradicting.length + related.length;
  
  if (totalEvidence === 0) {
    return { confidence: 0, label: 'none' };
  }
  
  // Weight by evidence type and scores
  const supportingWeight = supporting.reduce((sum, e) => sum + e.relevanceScore, 0);
  const contradictingWeight = contradicting.reduce((sum, e) => sum + e.relevanceScore * 0.8, 0);
  const relatedWeight = related.reduce((sum, e) => sum + e.relevanceScore * 0.3, 0);
  
  const totalWeight = supportingWeight + contradictingWeight + relatedWeight;
  
  // Calculate confidence based on supporting evidence ratio
  let confidence: number;
  if (totalWeight === 0) {
    confidence = 0;
  } else if (contradictingWeight > supportingWeight) {
    // More contradicting than supporting evidence
    confidence = 0.2 * (supportingWeight / totalWeight);
  } else {
    // More supporting than contradicting evidence
    confidence = (supportingWeight - contradictingWeight * 0.5) / totalWeight;
  }
  
  // Apply quantity bonus (more evidence = more confidence, up to a point)
  const quantityBonus = Math.min(0.2, totalEvidence * 0.02);
  confidence = Math.min(1, confidence + quantityBonus);
  
  // Determine label
  let label: 'high' | 'medium' | 'low' | 'none';
  if (confidence >= 0.7) label = 'high';
  else if (confidence >= 0.4) label = 'medium';
  else if (confidence > 0) label = 'low';
  else label = 'none';
  
  return { confidence, label };
}

/**
 * Generate a human-readable summary of the verification result.
 */
function generateVerificationSummary(
  claim: string,
  supporting: EvidenceHit[],
  contradicting: EvidenceHit[],
  related: EvidenceHit[],
  confidence: number,
  label: string
): string {
  const total = supporting.length + contradicting.length + related.length;
  
  if (total === 0) {
    return `No evidence found for: "${claim.slice(0, 50)}${claim.length > 50 ? '...' : ''}"`;
  }
  
  const parts: string[] = [];
  parts.push(`Found ${total} piece(s) of evidence (confidence: ${label})`);
  
  if (supporting.length > 0) {
    parts.push(`${supporting.length} supporting`);
  }
  if (contradicting.length > 0) {
    parts.push(`${contradicting.length} potentially contradicting`);
  }
  if (related.length > 0 && supporting.length + contradicting.length === 0) {
    parts.push(`${related.length} related but inconclusive`);
  }
  
  return parts.join('; ');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Verify a claim against the search index.
 * Returns classified evidence with confidence scoring.
 * 
 * This differs from searchIndex by:
 * 1. Classifying results as supporting/contradicting/related
 * 2. Calculating an overall confidence score
 * 3. Providing a human-readable summary
 */
export function verifyClaimInIndex(
  dbPath: string,
  claim: string,
  scope: SearchScope,
  limit: number,
  bundleRoot?: string
): VerificationResult {
  // Get raw search results
  const rawHits = searchIndex(dbPath, claim, scope, limit, bundleRoot);
  
  // Extract tokens from claim for classification
  const claimTokens = tokenizeForSafeQuery(claim);
  
  // Classify each hit
  const supporting: EvidenceHit[] = [];
  const contradicting: EvidenceHit[] = [];
  const related: EvidenceHit[] = [];
  
  for (const hit of rawHits) {
    const { type, score } = classifyEvidence(hit.snippet, claimTokens);
    const evidenceHit: EvidenceHit = {
      ...hit,
      evidenceType: type,
      relevanceScore: score,
    };
    
    switch (type) {
      case 'supporting':
        supporting.push(evidenceHit);
        break;
      case 'contradicting':
        contradicting.push(evidenceHit);
        break;
      case 'related':
        related.push(evidenceHit);
        break;
    }
  }
  
  // Sort each category by relevance score
  supporting.sort((a, b) => b.relevanceScore - a.relevanceScore);
  contradicting.sort((a, b) => b.relevanceScore - a.relevanceScore);
  related.sort((a, b) => b.relevanceScore - a.relevanceScore);
  
  // Calculate confidence
  const { confidence, label } = calculateConfidence(supporting, contradicting, related);
  
  // Generate summary
  const summary = generateVerificationSummary(claim, supporting, contradicting, related, confidence, label);
  
  return {
    claim,
    found: rawHits.length > 0,
    confidence,
    confidenceLabel: label,
    summary,
    supporting,
    contradicting,
    related,
  };
}
