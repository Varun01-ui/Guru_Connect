// Reads the pixel size of a PNG, JPEG or WebP from the file header, without decoding the image. Used to enforce
// fixed-size uploads (M44 FR-44.4: banners are 1080 x 480). Returns null for anything it cannot read.
export type ImageSize = { width: number; height: number }

export function readImageSize(buf: Buffer): ImageSize | null {
  return readPng(buf) ?? readJpeg(buf) ?? readWebp(buf)
}

function readPng(b: Buffer): ImageSize | null {
  if (b.length < 24 || !b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null
  if (b.subarray(12, 16).toString('latin1') !== 'IHDR') return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

function readJpeg(b: Buffer): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = b[i + 1]!
    if (marker === 0xff) {
      i += 1
      continue
    }
    // Markers without a length: SOI, EOI, RSTn, TEM.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const length = b.readUInt16BE(i + 2)
    // SOF0..SOF15 carry the frame size, except DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    }
    i += 2 + length
  }
  return null
}

function readWebp(b: Buffer): ImageSize | null {
  if (b.length < 30 || b.subarray(0, 4).toString('latin1') !== 'RIFF' || b.subarray(8, 12).toString('latin1') !== 'WEBP') return null
  const kind = b.subarray(12, 16).toString('latin1')
  if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
  if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return null
    const bits = b.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (kind === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  }
  return null
}
