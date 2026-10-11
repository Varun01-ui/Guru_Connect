import { describe, expect, it } from 'vitest'
import { jpegOf, pngOf, webpOf } from '../test/images.js'
import { readImageSize } from './imageSize.js'

describe('readImageSize', () => {
  it('reads PNG, JPEG and WebP headers', () => {
    expect(readImageSize(pngOf(1080, 480))).toEqual({ width: 1080, height: 480 })
    expect(readImageSize(jpegOf(1080, 480))).toEqual({ width: 1080, height: 480 })
    expect(readImageSize(webpOf(1080, 480))).toEqual({ width: 1080, height: 480 })
  })

  it('returns null for anything else', () => {
    expect(readImageSize(Buffer.from('<html></html>'))).toBeNull()
    expect(readImageSize(Buffer.alloc(0))).toBeNull()
    expect(readImageSize(pngOf(10, 10).subarray(0, 20))).toBeNull()
    expect(readImageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]))).toBeNull()
  })
})
