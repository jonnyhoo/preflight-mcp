/**
 * Python Documentation Checker - Docstring Parser
 *
 * Parses Google/NumPy/Sphinx style docstrings.
 *
 * @module analysis/doccheck/python/docstring-parser
 */

import type {
  DocInfo,
  DocParamInfo,
  DocYieldsInfo,
  DocRaisesInfo,
  DocAttributeInfo,
  PythonDocstringStyle,
} from '../types.js';
import { GOOGLE_PATTERNS, NUMPY_PATTERNS, SPHINX_PATTERNS } from './patterns.js';
import { parseParamTypeAnnotation } from './utils.js';

// ============================================================================
// Main Parser
// ============================================================================

/**
 * Parse docstring content based on configured style.
 */
export function parseDocstring(docstring: string, style?: PythonDocstringStyle): DocInfo {
  switch (style) {
    case 'google':
      return parseGoogleDocstring(docstring);
    case 'numpy':
      return parseNumpyDocstring(docstring);
    case 'sphinx':
      return parseSphinxDocstring(docstring);
    default:
      // Try to auto-detect
      if (SPHINX_PATTERNS.param.test(docstring)) {
        return parseSphinxDocstring(docstring);
      }
      if (GOOGLE_PATTERNS.argsSection.test(docstring)) {
        return parseGoogleDocstring(docstring);
      }
      if (NUMPY_PATTERNS.paramsSection.test(docstring)) {
        return parseNumpyDocstring(docstring);
      }
      // Default to Google
      return parseGoogleDocstring(docstring);
  }
}

// ============================================================================
// Google Style Parser
// ============================================================================

/**
 * Parse Google-style docstring.
 */
export function parseGoogleDocstring(docstring: string): DocInfo {
  const params: DocParamInfo[] = [];
  let returns: { type?: string; description?: string } | undefined;
  let yields: DocYieldsInfo | undefined;
  const raises: DocRaisesInfo[] = [];
  const attributes: DocAttributeInfo[] = [];
  const lines = docstring.split(/\r?\n/);

  let currentSection: 'none' | 'args' | 'returns' | 'yields' | 'raises' | 'attributes' = 'none';
  let description = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Check for section headers
    if (GOOGLE_PATTERNS.argsSection.test(line)) {
      currentSection = 'args';
      continue;
    }
    if (GOOGLE_PATTERNS.returnsSection.test(line)) {
      currentSection = 'returns';
      continue;
    }
    if (GOOGLE_PATTERNS.yieldsSection.test(line)) {
      currentSection = 'yields';
      continue;
    }
    if (GOOGLE_PATTERNS.raisesSection.test(line)) {
      currentSection = 'raises';
      continue;
    }
    if (GOOGLE_PATTERNS.attributesSection.test(line)) {
      currentSection = 'attributes';
      continue;
    }
    // Other section headers end current section
    if (/^(?:Examples?|Notes?|See Also|References|Warnings?)\s*:/i.test(line)) {
      currentSection = 'none';
      continue;
    }

    if (currentSection === 'args') {
      const match = line.match(GOOGLE_PATTERNS.param);
      if (match) {
        const paramInfo = parseParamTypeAnnotation(match[2]);
        params.push({
          name: match[1]!,
          type: paramInfo.type,
          description: match[3]?.trim(),
          optional: paramInfo.optional,
          defaultValue: paramInfo.defaultValue,
        });
      }
    } else if (currentSection === 'returns') {
      const match = line.match(GOOGLE_PATTERNS.returnType);
      if (match && !returns) {
        returns = {
          type: match[1],
          description: (match[2] || match[3])?.trim(),
        };
      }
    } else if (currentSection === 'yields') {
      const match = line.match(GOOGLE_PATTERNS.returnType);
      if (match && !yields) {
        yields = {
          type: match[1],
          description: (match[2] || match[3])?.trim(),
        };
      }
    } else if (currentSection === 'raises') {
      const match = line.match(GOOGLE_PATTERNS.raises);
      if (match) {
        raises.push({
          exception: match[1]!,
          description: match[2]?.trim(),
        });
      }
    } else if (currentSection === 'attributes') {
      const match = line.match(GOOGLE_PATTERNS.param); // Same format as params
      if (match) {
        attributes.push({
          name: match[1]!,
          type: match[2],
          description: match[3]?.trim(),
        });
      }
    } else if (currentSection === 'none' && i < 5) {
      // First few lines before any section are description
      if (line.trim()) {
        description += (description ? ' ' : '') + line.trim();
      }
    }
  }

  return {
    exists: true,
    params,
    returns,
    yields,
    raises: raises.length > 0 ? raises : undefined,
    attributes: attributes.length > 0 ? attributes : undefined,
    description: description || undefined,
    raw: docstring,
  };
}

// ============================================================================
// NumPy Style Parser
// ============================================================================

/**
 * Parse NumPy-style docstring.
 */
export function parseNumpyDocstring(docstring: string): DocInfo {
  const params: DocParamInfo[] = [];
  let returns: { type?: string; description?: string } | undefined;
  let yields: DocYieldsInfo | undefined;
  const raises: DocRaisesInfo[] = [];
  const attributes: DocAttributeInfo[] = [];
  const lines = docstring.split(/\r?\n/);

  let currentSection: 'none' | 'params' | 'returns' | 'yields' | 'raises' | 'attributes' = 'none';
  let currentParam: DocParamInfo | null = null;
  let currentRaise: DocRaisesInfo | null = null;
  let currentAttr: DocAttributeInfo | null = null;
  let description = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const nextLine = lines[i + 1];

    // Check for section headers (line followed by dashes)
    if (nextLine && NUMPY_PATTERNS.sectionUnderline.test(nextLine)) {
      // Save any pending param/raise/attr
      if (currentParam) { params.push(currentParam); currentParam = null; }
      if (currentRaise) { raises.push(currentRaise); currentRaise = null; }
      if (currentAttr) { attributes.push(currentAttr); currentAttr = null; }

      if (/^Parameters\s*$/i.test(line)) {
        currentSection = 'params';
        i++;
        continue;
      }
      if (/^Returns\s*$/i.test(line)) {
        currentSection = 'returns';
        i++;
        continue;
      }
      if (/^Yields\s*$/i.test(line)) {
        currentSection = 'yields';
        i++;
        continue;
      }
      if (/^Raises\s*$/i.test(line)) {
        currentSection = 'raises';
        i++;
        continue;
      }
      if (/^Attributes\s*$/i.test(line)) {
        currentSection = 'attributes';
        i++;
        continue;
      }
      // Other sections end current section
      currentSection = 'none';
      continue;
    }

    if (currentSection === 'params') {
      const paramMatch = line.match(NUMPY_PATTERNS.param);
      if (paramMatch && !line.startsWith('    ')) {
        if (currentParam) params.push(currentParam);
        currentParam = {
          name: paramMatch[1]!,
          type: paramMatch[2],
        };
      } else if (currentParam && NUMPY_PATTERNS.description.test(line)) {
        const descMatch = line.match(NUMPY_PATTERNS.description);
        if (descMatch) {
          currentParam.description = (currentParam.description || '') + descMatch[1];
        }
      }
    } else if (currentSection === 'returns') {
      if (!returns) {
        const typeMatch = line.match(/^(\w+(?:\[.+\])?)$/);
        if (typeMatch) {
          returns = { type: typeMatch[1] };
        }
      } else if (NUMPY_PATTERNS.description.test(line)) {
        const descMatch = line.match(NUMPY_PATTERNS.description);
        if (descMatch) {
          returns.description = (returns.description || '') + descMatch[1];
        }
      }
    } else if (currentSection === 'yields') {
      if (!yields) {
        const typeMatch = line.match(/^(\w+(?:\[.+\])?)$/);
        if (typeMatch) {
          yields = { type: typeMatch[1] };
        }
      } else if (NUMPY_PATTERNS.description.test(line)) {
        const descMatch = line.match(NUMPY_PATTERNS.description);
        if (descMatch) {
          yields.description = (yields.description || '') + descMatch[1];
        }
      }
    } else if (currentSection === 'raises') {
      const exMatch = line.match(/^(\w+(?:\.\w+)*)$/);
      if (exMatch && !line.startsWith('    ')) {
        if (currentRaise) raises.push(currentRaise);
        currentRaise = { exception: exMatch[1]! };
      } else if (currentRaise && NUMPY_PATTERNS.description.test(line)) {
        const descMatch = line.match(NUMPY_PATTERNS.description);
        if (descMatch) {
          currentRaise.description = (currentRaise.description || '') + descMatch[1];
        }
      }
    } else if (currentSection === 'attributes') {
      const attrMatch = line.match(NUMPY_PATTERNS.param); // Same format as params
      if (attrMatch && !line.startsWith('    ')) {
        if (currentAttr) attributes.push(currentAttr);
        currentAttr = {
          name: attrMatch[1]!,
          type: attrMatch[2],
        };
      } else if (currentAttr && NUMPY_PATTERNS.description.test(line)) {
        const descMatch = line.match(NUMPY_PATTERNS.description);
        if (descMatch) {
          currentAttr.description = (currentAttr.description || '') + descMatch[1];
        }
      }
    } else if (currentSection === 'none' && i < 5) {
      if (line.trim() && !NUMPY_PATTERNS.sectionUnderline.test(line)) {
        description += (description ? ' ' : '') + line.trim();
      }
    }
  }

  if (currentParam) params.push(currentParam);
  if (currentRaise) raises.push(currentRaise);
  if (currentAttr) attributes.push(currentAttr);

  return {
    exists: true,
    params,
    returns,
    yields,
    raises: raises.length > 0 ? raises : undefined,
    attributes: attributes.length > 0 ? attributes : undefined,
    description: description || undefined,
    raw: docstring,
  };
}

// ============================================================================
// Sphinx Style Parser
// ============================================================================

/**
 * Parse Sphinx-style docstring.
 */
export function parseSphinxDocstring(docstring: string): DocInfo {
  const params: DocParamInfo[] = [];
  const paramTypes = new Map<string, string>();
  let returns: { type?: string; description?: string } | undefined;
  let yields: DocYieldsInfo | undefined;
  const raises: DocRaisesInfo[] = [];
  const attributes: DocAttributeInfo[] = [];
  const attrTypes = new Map<string, string>();
  const lines = docstring.split(/\r?\n/);
  let description = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // :param type name: description or :param name: description
    const paramMatch = line.match(SPHINX_PATTERNS.param);
    if (paramMatch) {
      params.push({
        name: paramMatch[2]!,
        type: paramMatch[1],
        description: paramMatch[3]?.trim(),
      });
      continue;
    }

    // :type name: type
    const typeMatch = line.match(SPHINX_PATTERNS.paramType);
    if (typeMatch) {
      paramTypes.set(typeMatch[1]!, typeMatch[2]!);
      continue;
    }

    // :returns: description
    const returnsMatch = line.match(SPHINX_PATTERNS.returns);
    if (returnsMatch) {
      returns = { description: returnsMatch[1]?.trim() };
      continue;
    }

    // :rtype: type
    const rtypeMatch = line.match(SPHINX_PATTERNS.returnType);
    if (rtypeMatch) {
      if (returns) {
        returns.type = rtypeMatch[1]?.trim();
      } else {
        returns = { type: rtypeMatch[1]?.trim() };
      }
      continue;
    }

    // :yields: description
    const yieldsMatch = line.match(SPHINX_PATTERNS.yields);
    if (yieldsMatch) {
      yields = { description: yieldsMatch[1]?.trim() };
      continue;
    }

    // :ytype: type
    const ytypeMatch = line.match(SPHINX_PATTERNS.yieldsType);
    if (ytypeMatch) {
      if (yields) {
        yields.type = ytypeMatch[1]?.trim();
      } else {
        yields = { type: ytypeMatch[1]?.trim() };
      }
      continue;
    }

    // :raises ExceptionType: description
    const raisesMatch = line.match(SPHINX_PATTERNS.raises);
    if (raisesMatch) {
      raises.push({
        exception: raisesMatch[1]!,
        description: raisesMatch[2]?.trim(),
      });
      continue;
    }

    // :ivar/:cvar type name: description for attributes
    const attrMatch = line.match(SPHINX_PATTERNS.attribute);
    if (attrMatch) {
      attributes.push({
        name: attrMatch[2]!,
        type: attrMatch[1],
        description: attrMatch[3]?.trim(),
      });
      continue;
    }

    // :vartype name: type
    const varTypeMatch = line.match(SPHINX_PATTERNS.attrType);
    if (varTypeMatch) {
      attrTypes.set(varTypeMatch[1]!, varTypeMatch[2]!);
      continue;
    }

    // Collect description (lines before first :param or :returns)
    if (!line.startsWith(':') && i < 5) {
      if (line.trim()) {
        description += (description ? ' ' : '') + line.trim();
      }
    }
  }

  // Merge separate :type declarations into params
  for (const param of params) {
    if (!param.type && paramTypes.has(param.name)) {
      param.type = paramTypes.get(param.name);
    }
  }

  // Merge separate :vartype declarations into attributes
  for (const attr of attributes) {
    if (!attr.type && attrTypes.has(attr.name)) {
      attr.type = attrTypes.get(attr.name);
    }
  }

  return {
    exists: true,
    params,
    returns,
    yields,
    raises: raises.length > 0 ? raises : undefined,
    attributes: attributes.length > 0 ? attributes : undefined,
    description: description || undefined,
    raw: docstring,
  };
}
