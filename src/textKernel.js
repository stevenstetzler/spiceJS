/**
 * Parser for SPICE "text kernels" -- the KPL/* format used by LSK,
 * FK, IK, SCLK and meta-kernel (MK) files (as opposed to the binary
 * DAF-based formats used by SPK/CK/PCK).
 *
 * A text kernel alternates between `\begintext` sections (free-form
 * comments, ignored) and `\begindata` sections containing Fortran
 * namelist-style variable assignments:
 *
 *   NAME = value
 *   NAME += value          (append to an existing variable)
 *   NAME = ( v1, v2, v3 )  (array; may span multiple lines)
 *
 * where a `value` is a quoted string ('it''s escaped by doubling'),
 * a number (including Fortran "D" exponents, e.g. 1.657D-3), or an
 * "@" date literal (e.g. @1972-JAN-1), which is resolved immediately
 * to continuous seconds past J2000 -- see calendar.js.
 */
import { parseAtLiteral } from './time/calendar.js';

// Matches, in priority order: a quoted string, a paren, the += or =
// operators, or a run of non-whitespace/non-paren/non-comma
// characters (numbers, bare identifiers, @-literals). Commas are not
// matched by anything and so act as token separators, same as
// whitespace.
const TOKEN_RE = /'(?:[^']|'')*'|\(|\)|\+=|=|[^\s(),]+/g;

/** Split raw text-kernel content into just its \begindata text. */
function extractDataText(content) {
  const lines = content.split(/\r\n|\r|\n/);
  let inData = false;
  const dataLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '\\begindata') {
      inData = true;
      continue;
    }
    if (trimmed === '\\begintext') {
      inData = false;
      continue;
    }
    if (inData) {
      dataLines.push(line);
    }
  }
  return dataLines.join(' ');
}

function parseValueToken(token) {
  if (token[0] === "'") {
    return token.slice(1, -1).replace(/''/g, "'");
  }
  if (token[0] === '@') {
    return parseAtLiteral(token);
  }
  const numeric = Number(token.replace(/D/i, 'E'));
  if (Number.isNaN(numeric)) {
    throw new Error(`Malformed text kernel: could not parse value "${token}"`);
  }
  return numeric;
}

/**
 * Parse the `\begindata` sections of a text kernel's content into an
 * ordered list of assignments: `{ name, values, append }`.
 */
export function parseAssignments(content) {
  const tokens = extractDataText(content).match(TOKEN_RE) || [];
  const assignments = [];
  let i = 0;
  while (i < tokens.length) {
    const name = tokens[i++];
    const op = tokens[i++];
    if (op !== '=' && op !== '+=') {
      throw new Error(
        `Malformed text kernel: expected "=" or "+=" after "${name}", got ${
          op === undefined ? 'end of input' : `"${op}"`
        }`
      );
    }
    let values;
    if (tokens[i] === '(') {
      i++;
      values = [];
      while (tokens[i] !== ')') {
        if (i >= tokens.length) {
          throw new Error(`Malformed text kernel: unterminated array assigned to "${name}"`);
        }
        values.push(parseValueToken(tokens[i++]));
      }
      i++; // consume ')'
    } else {
      if (i >= tokens.length) {
        throw new Error(`Malformed text kernel: "${name} ${op}" is missing a value`);
      }
      values = [parseValueToken(tokens[i++])];
    }
    assignments.push({ name, values, append: op === '+=' });
  }
  return assignments;
}

/**
 * Apply a text kernel's assignments to a kernel pool.
 *
 * @returns {Array<{name: string, hadPrevious: boolean, previousValue: Array|undefined}>}
 *   One entry per variable *first* touched by this file, recording
 *   its prior value (if any) so furnsh()/unload() can undo the load.
 */
export function loadTextKernel(content, pool) {
  const changes = [];
  const touched = new Set();
  for (const { name, values, append } of parseAssignments(content)) {
    if (!touched.has(name)) {
      touched.add(name);
      changes.push({ name, hadPrevious: pool.has(name), previousValue: pool.getValues(name) });
    }
    pool.putValues(name, values, append);
  }
  return changes;
}
