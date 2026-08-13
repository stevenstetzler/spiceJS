/**
 * Reader for the DAF (Double precision Array File) binary container
 * format that SPK (and, not yet supported here, binary PCK and CK)
 * kernels use. This module knows nothing about what the summaries
 * *mean* -- see spk.js for that -- it only knows how to walk a DAF's
 * file record and summary-record chain and hand back raw
 * `{ dc, ic }` summaries plus a way to read arbitrary spans of the
 * file's data words.
 *
 * Format (byte-verified against NAIF's own source -- zzdafnfr.c for
 * the file record layout, dafps.c/dafus.c for summary packing):
 *
 *   Record 1 (bytes 0-1024), the "file record":
 *     LOCIDW   0-8     ID word, e.g. "DAF/SPK "
 *     ND       8-12    int32: # double components per summary
 *     NI       12-16   int32: # int components per summary
 *     LOCIFN   16-76   internal file name (60 chars, ignored here)
 *     FWARD    76-80   int32: record # of first summary record
 *     BWARD    80-84   int32: record # of last summary record
 *     FREE     84-88   int32: first free DAF address (ignored here)
 *     LOCFMT   88-96   "LTL-IEEE" or "BIG-IEEE" -- byte order for
 *                      every numeric field in the file, including the
 *                      ones above (LOCFMT itself is plain ASCII, so
 *                      it has to be read before ND/NI/FWARD/BWARD can
 *                      be decoded).
 *     (96-1024 is reserved / an FTP-corruption check string; unused
 *     here.)
 *
 *   Summary records (1024 bytes each, i.e. 128 float64 "words"):
 *     word[0..3) = NEXT, PREV, NSUM (record # of next/previous summary
 *     record in the linked list, and how many summaries follow here).
 *     Then NSUM summaries, each occupying `ND + ceil(NI/2)` words --
 *     that stride comes from the classic Fortran trick of packing two
 *     4-byte ints per 8-byte word, which (for *reading*) is exactly
 *     equivalent to just reading `NI` int32s back-to-back right after
 *     the `ND` float64s; only the amount to advance to the *next*
 *     summary needs the padded word count.
 *   Traversal starts at record FWARD and follows NEXT; record 1 and
 *   any "comment area" between it and FWARD are simply never visited.
 *   The paired "name records" (human-readable array names) are not
 *   read -- lookups here are by numeric ID, not by name.
 */

const FILE_RECORD_BYTES = 1024;
const WORD_BYTES = 8;

function readAscii(buffer, start, end) {
  return buffer.toString('latin1', start, end).replace(/\0/g, '').trim();
}

/** Parse the file record (record 1) and validate it's a DAF this reader understands. */
export function parseFileRecord(buffer) {
  if (buffer.length < FILE_RECORD_BYTES) {
    throw new Error('daf: file is too small to contain a DAF file record');
  }
  const idWord = readAscii(buffer, 0, 8);
  // "NAIF/DAF" is a real, older, generic ID word -- several of NAIF's
  // own publicly distributed kernels (e.g. the DSN station-position
  // SPKs) use it instead of a type-specific word like "DAF/SPK". Real
  // CSPICE still reads these (confirmed empirically), so this generic
  // reader accepts it too; the caller (e.g. spk.js/pck.js/kernels.js)
  // is responsible for further narrowing by summary shape or content.
  if (!idWord.startsWith('DAF/') && idWord !== 'NAIF/DAF') {
    throw new Error(`daf: not a DAF file (expected an ID word starting with "DAF/", got "${idWord}")`);
  }

  const format = readAscii(buffer, 88, 96);
  let littleEndian;
  if (format === 'LTL-IEEE') {
    littleEndian = true;
  } else if (format === 'BIG-IEEE') {
    littleEndian = false;
  } else {
    throw new Error(
      `daf: unsupported binary format "${format}" in "${idWord}" (only LTL-IEEE and BIG-IEEE are ` +
        'supported -- legacy VAX-format DAFs are not)'
    );
  }

  const readInt32 = (offset) => (littleEndian ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset));

  return {
    idWord,
    littleEndian,
    nd: readInt32(8),
    ni: readInt32(12),
    fward: readInt32(76),
    bward: readInt32(80),
    free: readInt32(84),
  };
}

/** Read the float64 words at 1-based DAF addresses [startAddr, endAddr] (inclusive). */
export function readWords(buffer, littleEndian, startAddr, endAddr) {
  const count = endAddr - startAddr + 1;
  if (count < 0) {
    throw new Error(`daf: invalid address range [${startAddr}, ${endAddr}]`);
  }
  const out = new Float64Array(count);
  const byteOffset = (startAddr - 1) * WORD_BYTES;
  for (let i = 0; i < count; i++) {
    out[i] = littleEndian
      ? buffer.readDoubleLE(byteOffset + i * WORD_BYTES)
      : buffer.readDoubleBE(byteOffset + i * WORD_BYTES);
  }
  return out;
}

/**
 * Parse a whole DAF: the file record plus every summary reachable by
 * walking the summary-record chain from FWARD.
 *
 * @returns {{ idWord, littleEndian, nd, ni, summaries: Array<{dc: number[], ic: number[]}> }}
 */
export function parseDaf(buffer) {
  const fileRecord = parseFileRecord(buffer);
  const { littleEndian, nd, ni } = fileRecord;
  const summarySize = nd + Math.ceil(ni / 2); // words, including any unused trailing half-word
  const readInt32 = (offset) => (littleEndian ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset));

  const summaries = [];
  let recordNumber = fileRecord.fward;
  const visited = new Set();
  while (recordNumber !== 0) {
    if (visited.has(recordNumber)) {
      throw new Error(`daf: summary record chain loops back to record ${recordNumber}`);
    }
    visited.add(recordNumber);

    const recordOffset = (recordNumber - 1) * FILE_RECORD_BYTES;
    const next = littleEndian ? buffer.readDoubleLE(recordOffset) : buffer.readDoubleBE(recordOffset);
    const nsum = littleEndian ? buffer.readDoubleLE(recordOffset + 16) : buffer.readDoubleBE(recordOffset + 16);

    let wordOffset = recordOffset + 24; // past NEXT, PREV, NSUM
    for (let i = 0; i < Math.round(nsum); i++) {
      const dc = [];
      for (let j = 0; j < nd; j++) {
        const off = wordOffset + j * WORD_BYTES;
        dc.push(littleEndian ? buffer.readDoubleLE(off) : buffer.readDoubleBE(off));
      }
      const icByteOffset = wordOffset + nd * WORD_BYTES;
      const ic = [];
      for (let j = 0; j < ni; j++) {
        ic.push(readInt32(icByteOffset + j * 4));
      }
      summaries.push({ dc, ic });
      wordOffset += summarySize * WORD_BYTES;
    }

    recordNumber = Math.round(next);
  }

  return { idWord: fileRecord.idWord, littleEndian, nd, ni, summaries };
}
