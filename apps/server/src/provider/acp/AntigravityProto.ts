/** Minimal protobuf reader for agy's private conversation steps. */
/** Length-delimited fields only; varints and fixed values are skipped. */
function protoFields(bytes: Uint8Array): ReadonlyArray<readonly [number, Uint8Array]> {
  const fields: Array<readonly [number, Uint8Array]> = [];
  let offset = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error("Truncated varint");
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    throw new Error("Overlong varint");
  };
  while (offset < bytes.length) {
    const key = varint();
    const wire = key % 8;
    const field = Math.floor(key / 8);
    if (wire === 0) varint();
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else if (wire === 2) {
      const length = varint();
      if (offset + length > bytes.length) throw new Error("Truncated field");
      fields.push([field, bytes.subarray(offset, offset + length)]);
      offset += length;
    } else throw new Error("Unsupported wire type");
  }
  if (offset > bytes.length) throw new Error("Truncated field");
  return fields;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const messages = (bytes: Uint8Array, field: number) =>
  protoFields(bytes).flatMap(([number, value]) => (number === field ? [value] : []));
export const message = (bytes: Uint8Array | undefined, field: number) =>
  bytes === undefined ? undefined : messages(bytes, field)[0];
export const text = (bytes: Uint8Array | undefined, field: number) => {
  const value = message(bytes, field);
  return value === undefined ? undefined : textDecoder.decode(value);
};
