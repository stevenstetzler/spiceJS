import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAssignments, loadTextKernel } from '../src/textKernel.js';
import { KernelPool } from '../src/pool.js';
import { calendarToSeconds } from '../src/time/calendar.js';

test('parses a scalar number assignment', () => {
  const out = parseAssignments(`\\begindata\nDELTET/DELTA_T_A = 32.184\n\\begintext\n`);
  assert.deepEqual(out, [{ name: 'DELTET/DELTA_T_A', values: [32.184], append: false }]);
});

test('parses Fortran "D" exponent notation', () => {
  const out = parseAssignments(`\\begindata\nDELTET/K = 1.657D-3\n\\begintext\n`);
  assert.equal(out[0].values[0], 1.657e-3);
});

test('parses a parenthesized array spanning multiple lines', () => {
  const out = parseAssignments(`\\begindata\nBODY_RADII = ( 1.1\n               2.2\n               3.3 )\n\\begintext\n`);
  assert.deepEqual(out[0].values, [1.1, 2.2, 3.3]);
});

test('parses quoted strings, including doubled-quote escaping', () => {
  const out = parseAssignments(`\\begindata\nNAME = 'it''s a test'\n\\begintext\n`);
  assert.equal(out[0].values[0], "it's a test");
});

test('parses "@" date literals into continuous seconds', () => {
  const out = parseAssignments(`\\begindata\nEPOCH = @1972-JAN-1\n\\begintext\n`);
  assert.equal(out[0].values[0], calendarToSeconds(1972, 1, 1));
});

test('parses "=" and "+=" with no surrounding whitespace (real gm_de440.tpc: "BODY000_GMLIST= (...")', () => {
  const out = parseAssignments(`\\begindata\nBODY000_GMLIST= ( 1 2 3 )\nLIST+=( 4 5 )\n\\begintext\n`);
  assert.deepEqual(out[0], { name: 'BODY000_GMLIST', values: [1, 2, 3], append: false });
  assert.deepEqual(out[1], { name: 'LIST', values: [4, 5], append: true });
});

test('does not mistake a number\'s "+" exponent sign for the start of a "+=" operator', () => {
  const out = parseAssignments(`\\begindata\nX = 1.5E+10\n\\begintext\n`);
  assert.deepEqual(out, [{ name: 'X', values: [1.5e10], append: false }]);
});

test('honors the += append operator', () => {
  const out = parseAssignments(`\\begindata\nLIST = ( 1, 2 )\nLIST += ( 3, 4 )\n\\begintext\n`);
  assert.equal(out.length, 2);
  assert.equal(out[1].append, true);
  assert.deepEqual(out[1].values, [3, 4]);
});

test('ignores content before the first \\begindata and inside \\begintext blocks', () => {
  const out = parseAssignments(
    `KPL/LSK\nThis is a comment.\n= not data =\n\\begindata\nA = 1\n\\begintext\nAnother comment = not parsed\n\\begindata\nB = 2\n`
  );
  assert.deepEqual(
    out.map((a) => a.name),
    ['A', 'B']
  );
});

test('loadTextKernel applies assignments to a pool and reports prior state', () => {
  const pool = new KernelPool();
  pool.putValues('A', [999]);
  const changes = loadTextKernel(`\\begindata\nA = 1\nB = ( 2, 3 )\n`, pool);
  assert.deepEqual(pool.getValues('A'), [1]);
  assert.deepEqual(pool.getValues('B'), [2, 3]);

  const aChange = changes.find((c) => c.name === 'A');
  assert.equal(aChange.hadPrevious, true);
  assert.deepEqual(aChange.previousValue, [999]);

  const bChange = changes.find((c) => c.name === 'B');
  assert.equal(bChange.hadPrevious, false);
});

test('throws a clear error for malformed input', () => {
  assert.throws(() => parseAssignments('\\begindata\nA ~ 1\n'), /expected "=" or "\+="/);
  assert.throws(() => parseAssignments('\\begindata\nA = ( 1, 2\n'), /unterminated array/);
});
