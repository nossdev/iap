/**
 * Logging redaction utilities.
 *
 * The library NEVER logs full purchase tokens, JWS payloads, receipts,
 * or auth headers (PLAN.md §13). These helpers produce safe-to-log
 * representations that preserve enough information for debugging
 * without leaking sensitive data.
 */

const VISIBLE_PREFIX_CHARS = 8;
const ELLIPSIS = '…';

/**
 * Mask a token-like string. Returns the first 8 characters followed by
 * an ellipsis. Returns the input unchanged if it's already shorter than
 * 8 characters (no privacy gain to masking) or empty.
 *
 * @example
 *   maskToken('GPA.1234-5678-9012-34567') → 'GPA.1234…'
 *   maskToken('2000000123456789')         → '20000001…'
 *   maskToken('short')                    → 'short'
 *   maskToken('')                         → ''
 */
export function maskToken(token: string | null | undefined): string {
  if (!token) return '';
  if (token.length <= VISIBLE_PREFIX_CHARS) return token;
  return token.slice(0, VISIBLE_PREFIX_CHARS) + ELLIPSIS;
}

const SENSITIVE_HEADER_PATTERNS = [
  /^authorization$/i,
  /^cookie$/i,
  /^x-api-key$/i,
  /^x-auth-token$/i,
];

/**
 * Return a copy of a headers map with sensitive values masked.
 * Header NAMES are preserved (case-insensitive match against known
 * sensitive patterns); only the value is redacted.
 *
 * @example
 *   redactHeaders({ Authorization: 'Bearer abc123def456', 'X-Trace-Id': 'xyz' })
 *   → { Authorization: 'Bearer a…', 'X-Trace-Id': 'xyz' }
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveHeader(name) ? redactHeaderValue(value) : value;
  }
  return out;
}

function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_PATTERNS.some((pattern) => pattern.test(name));
}

function redactHeaderValue(value: string): string {
  // Bearer tokens and API keys: mask the credential portion but keep the scheme.
  const bearerMatch = value.match(/^(Bearer|Basic|Token)\s+(.+)$/i);
  if (bearerMatch) {
    const [, scheme, credential] = bearerMatch;
    return `${scheme} ${maskToken(credential ?? '')}`;
  }
  return maskToken(value);
}
