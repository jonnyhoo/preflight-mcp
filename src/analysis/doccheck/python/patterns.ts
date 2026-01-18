/**
 * Python Documentation Checker - Docstring Parsing Patterns
 *
 * @module analysis/doccheck/python/patterns
 */

// ============================================================================
// Docstring Parsing Patterns
// ============================================================================

/**
 * Patterns for Google-style docstrings.
 */
export const GOOGLE_PATTERNS = {
  // Args: or Arguments: (with optional leading whitespace)
  argsSection: /^\s*(?:Args|Arguments)\s*:\s*$/im,
  // Returns: or Return:
  returnsSection: /^\s*(?:Returns?)\s*:\s*$/im,
  // Yields:
  yieldsSection: /^\s*(?:Yields?)\s*:\s*$/im,
  // Raises:
  raisesSection: /^\s*(?:Raises?)\s*:\s*$/im,
  // Attributes:
  attributesSection: /^\s*(?:Attributes?)\s*:\s*$/im,
  // param_name (type): description or param_name: description
  param: /^\s{4,}(\w+)\s*(?:\(([^)]+)\))?\s*:\s*(.*)$/,
  // (type): description or just description
  returnType: /^\s{4,}(?:\(([^)]+)\))?\s*:\s*(.*)$|^\s{4,}(.+)$/,
  // ExceptionType: description
  raises: /^\s{4,}(\w+(?:\.\w+)*)\s*:\s*(.*)$/,
};

/**
 * Patterns for NumPy-style docstrings.
 */
export const NUMPY_PATTERNS = {
  // Parameters or Parameters: (with optional leading whitespace)
  paramsSection: /^\s*Parameters\s*$/im,
  // Returns or Returns:
  returnsSection: /^\s*Returns\s*$/im,
  // Yields
  yieldsSection: /^\s*Yields\s*$/im,
  // Raises
  raisesSection: /^\s*Raises\s*$/im,
  // Attributes
  attributesSection: /^\s*Attributes\s*$/im,
  // Dashes under section header
  sectionUnderline: /^-{3,}\s*$/,
  // param_name : type or param_name
  param: /^(\w+)\s*(?::\s*(.+))?$/,
  // Description on next line(s)
  description: /^\s{4,}(.+)$/,
};

/**
 * Patterns for Sphinx-style docstrings.
 */
export const SPHINX_PATTERNS = {
  // :param name: description or :param type name: description
  param: /^:param\s+(?:(\w+)\s+)?(\w+)\s*:\s*(.*)$/im,
  // :type name: type
  paramType: /^:type\s+(\w+)\s*:\s*(.*)$/im,
  // :returns: description or :return: description
  returns: /^:returns?\s*:\s*(.*)$/im,
  // :rtype: type
  returnType: /^:rtype\s*:\s*(.*)$/im,
  // :yields: description
  yields: /^:yields?\s*:\s*(.*)$/im,
  // :ytype: type
  yieldsType: /^:ytype\s*:\s*(.*)$/im,
  // :raises ExceptionType: description
  raises: /^:raises?\s+(\w+(?:\.\w+)*)\s*:\s*(.*)$/im,
  // :ivar name: description or :ivar type name: description
  attribute: /^:(?:ivar|cvar)\s+(?:(\w+)\s+)?(\w+)\s*:\s*(.*)$/im,
  // :vartype name: type
  attrType: /^:vartype\s+(\w+)\s*:\s*(.*)$/im,
};
