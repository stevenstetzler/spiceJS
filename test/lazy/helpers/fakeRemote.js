import { RemoteFile } from '../../../src/lazy/remoteFile.js';

/** Wraps a real, already-encoded kernel buffer (e.g. from writeSpk()) as a fake "remote" source, logging every range request. */
export function fakeRemoteSource(wholeFileBuffer) {
  const requests = [];
  const resolveRange = async (url, startByte, endByteExclusive) => {
    requests.push([startByte, endByteExclusive]);
    return wholeFileBuffer.subarray(startByte, endByteExclusive);
  };
  return { fileLength: wholeFileBuffer.byteLength, requests, resolveRange };
}

/** A RemoteFile wired to a real in-memory buffer instead of the network -- for deterministic, real-byte tests. */
export function fakeRemoteFile(wholeFileBuffer, { blockBytes, cache } = {}) {
  const { fileLength, requests, resolveRange } = fakeRemoteSource(wholeFileBuffer);
  const remoteFile = new RemoteFile('fake://kernel.bsp', fileLength, { blockBytes, cache, resolveRange });
  return { remoteFile, requests };
}
