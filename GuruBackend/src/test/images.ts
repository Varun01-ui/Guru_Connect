// Smallest byte strings the header readers and magic-byte sniffing accept, at any size. Not decodable images.
export function pngOf(width: number, height: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  b[24] = 8
  b[25] = 6
  return b
}

export function jpegOf(width: number, height: number): Buffer {
  const b = Buffer.alloc(32)
  b[0] = 0xff
  b[1] = 0xd8
  // An APP0 segment first, so the reader has to skip a segment to find the frame header.
  b[2] = 0xff
  b[3] = 0xe0
  b.writeUInt16BE(6, 4)
  b[10] = 0xff
  b[11] = 0xc0
  b.writeUInt16BE(11, 12)
  b[14] = 8
  b.writeUInt16BE(height, 15)
  b.writeUInt16BE(width, 17)
  b[19] = 3
  return b
}

export function webpOf(width: number, height: number): Buffer {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'latin1')
  b.writeUInt32LE(22, 4)
  b.write('WEBP', 8, 'latin1')
  b.write('VP8X', 12, 'latin1')
  b.writeUInt32LE(10, 16)
  b.writeUIntLE(width - 1, 24, 3)
  b.writeUIntLE(height - 1, 27, 3)
  return b
}
