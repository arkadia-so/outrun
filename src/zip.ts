// The files of a zip archive (GitHub's run logs: a folder per job, a file per step), read whole in
// memory. Pure apart from zlib: stored and deflated entries, no ZIP64 (an archive over 4 GB), no
// encryption; anything else is not an entry.
import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The archive's files by name, each read on demand; undefined when [bytes] is no zip this reads. */
export const zipEntries = (bytes: Uint8Array): ReadonlyMap<string, () => Uint8Array> | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end of central directory record: its 22 bytes, then a comment of up to 64 KiB.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--)
    if (view.getUint32(at, true) === EOCD) {
      end = at;
      break;
    }
  if (end < 0) return undefined;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = new Map<string, () => Uint8Array>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL) return undefined;
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== LOCAL || (method !== 0 && method !== 8)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    files.set(name, () => (method === 0 ? data : new Uint8Array(inflateRawSync(data))));
  }
  return files;
};
