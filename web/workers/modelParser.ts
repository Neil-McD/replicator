/*
  Model parser worker — minimal STL (binary) parser.
  Input: { type: 'parse-stl', bytes: ArrayBuffer }
  Output: { type: 'stl', ok: true, positions: ArrayBuffer, normals: ArrayBuffer, count: number }
  On failure: { type: 'stl', ok: false, error: string }
*/

function isLikelyAsciiSTL(bytes: ArrayBuffer): boolean {
  try {
    const header = new Uint8Array(bytes, 0, Math.min(80, bytes.byteLength))
    const text = new TextDecoder('ascii', { fatal: false }).decode(header)
    return text.startsWith('solid ') && !text.includes('facet') ? true : false
  } catch {
    return false
  }
}

function parseBinarySTL(bytes: ArrayBuffer) {
  if (bytes.byteLength < 84) throw new Error('stl_too_small')
  const dv = new DataView(bytes)
  const triCount = dv.getUint32(80, true)
  const expected = 84 + triCount * 50
  if (bytes.byteLength < expected) throw new Error('stl_truncated')
  const positions = new Float32Array(triCount * 9)
  const normals = new Float32Array(triCount * 9)
  let offset = 84
  for (let i = 0; i < triCount; i++) {
    const nx = dv.getFloat32(offset + 0, true)
    const ny = dv.getFloat32(offset + 4, true)
    const nz = dv.getFloat32(offset + 8, true)
    const v0x = dv.getFloat32(offset + 12, true)
    const v0y = dv.getFloat32(offset + 16, true)
    const v0z = dv.getFloat32(offset + 20, true)
    const v1x = dv.getFloat32(offset + 24, true)
    const v1y = dv.getFloat32(offset + 28, true)
    const v1z = dv.getFloat32(offset + 32, true)
    const v2x = dv.getFloat32(offset + 36, true)
    const v2y = dv.getFloat32(offset + 40, true)
    const v2z = dv.getFloat32(offset + 44, true)
    // attribute byte count at offset + 48 (ignored)
    const pBase = i * 9
    positions[pBase + 0] = v0x
    positions[pBase + 1] = v0y
    positions[pBase + 2] = v0z
    positions[pBase + 3] = v1x
    positions[pBase + 4] = v1y
    positions[pBase + 5] = v1z
    positions[pBase + 6] = v2x
    positions[pBase + 7] = v2y
    positions[pBase + 8] = v2z
    normals[pBase + 0] = nx
    normals[pBase + 1] = ny
    normals[pBase + 2] = nz
    normals[pBase + 3] = nx
    normals[pBase + 4] = ny
    normals[pBase + 5] = nz
    normals[pBase + 6] = nx
    normals[pBase + 7] = ny
    normals[pBase + 8] = nz
    offset += 50
  }
  return { positions, normals, count: triCount }
}

self.onmessage = (e: MessageEvent) => {
  const data = e.data || {}
  if (data.type === 'parse-stl' && data.bytes) {
    try {
      const bytes: ArrayBuffer = data.bytes
      if (isLikelyAsciiSTL(bytes)) {
        // Allow main-thread parser to handle ASCII as a fallback
        ;(self as any).postMessage({ type: 'stl', ok: false, error: 'ascii_unsupported' })
        return
      }
      const out = parseBinarySTL(bytes)
      ;(self as any).postMessage(
        { type: 'stl', ok: true, positions: out.positions.buffer, normals: out.normals.buffer, count: out.count },
        [out.positions.buffer, out.normals.buffer]
      )
    } catch (err: any) {
      ;(self as any).postMessage({ type: 'stl', ok: false, error: String(err?.message || err) })
    }
  }
}

