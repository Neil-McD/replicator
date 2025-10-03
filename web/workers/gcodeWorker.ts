/// <reference lib="webworker" />

import { unzipSync, strFromU8 } from 'fflate'

type FeatureKind = 'perimeter' | 'infill' | 'support'

type LayerSegment = {
  kind: FeatureKind
  buffer: ArrayBuffer
  vertexCount: number
}

type LayerPayload = {
  index: number
  z: number
  segments: LayerSegment[]
}

type ParseMessage = {
  type: 'parse'
  buffer: ArrayBuffer
  id?: string
}

type ResultMessage = {
  type: 'result'
  id?: string
  layers: LayerPayload[]
  bbox: { min: [number, number, number]; max: [number, number, number] }
}

declare const self: DedicatedWorkerGlobalScope

const FEATURE_MAP: Record<string, FeatureKind> = {
  'WALL-OUTER': 'perimeter',
  'WALL-INNER': 'perimeter',
  'WALL-INNER-1': 'perimeter',
  'WALL-INNER-2': 'perimeter',
  'SKIN': 'infill',
  'FILL': 'infill',
  'INFILL': 'infill',
  'TOP-SOLID-FILL': 'infill',
  'BOTTOM-SOLID-FILL': 'infill',
  'SUPPORT': 'support',
  'SUPPORT-INTERFACE': 'support',
}

function parseGCode(gcode: string): ResultMessage {
  const layers: LayerPayload[] = []
  let currentLayer = 0
  let currentKind: FeatureKind = 'perimeter'
  let lastX = 0
  let lastY = 0
  let lastZ = 0
  let lastE = 0
  let currentZ = 0
  const transfer: ArrayBuffer[] = []
  const bboxMin: [number, number, number] = [Infinity, Infinity, Infinity]
  const bboxMax: [number, number, number] = [-Infinity, -Infinity, -Infinity]

  const ensureLayer = (idx: number) => {
    if (!layers[idx]) {
      layers[idx] = { index: idx, z: currentZ, segments: [] }
    }
  }

  const ensureSegment = (idx: number, kind: FeatureKind) => {
    ensureLayer(idx)
    const layer = layers[idx]
    let seg = layer.segments.find((s) => s.kind === kind)
    if (!seg) {
      const arr: number[] = []
      const float = new Float32Array()
      seg = { kind, buffer: float.buffer, vertexCount: 0 }
      ;(seg as any)._points = arr
      layer.segments.push(seg)
    }
    return seg
  }

  const lines = gcode.split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith(';')) {
      if (line.startsWith(';TYPE:')) {
        const key = line.slice(6).trim().toUpperCase()
        currentKind = FEATURE_MAP[key] || currentKind
      } else if (line.startsWith(';LAYER:')) {
        const parsed = Number(line.slice(7))
        if (Number.isFinite(parsed)) {
          currentLayer = parsed
          ensureLayer(currentLayer)
          layers[currentLayer].z = currentZ
        }
      }
      continue
    }

    if (!line.startsWith('G1')) {
      const matchZ = line.match(/Z([\d\.-]+)/)
      if (matchZ) {
        const z = Number(matchZ[1])
        if (Number.isFinite(z)) currentZ = z
      }
      continue
    }

    const tokens = line.split(/[\s]+/)
    let x = lastX
    let y = lastY
    let z = lastZ
    let e = lastE
    for (const token of tokens) {
      const prefix = token[0]
      const value = Number(token.slice(1))
      if (!Number.isFinite(value)) continue
      switch (prefix) {
        case 'X':
          x = value
          break
        case 'Y':
          y = value
          break
        case 'Z':
          z = value
          currentZ = z
          break
        case 'E':
          e = value
          break
        default:
          break
      }
    }

    const extruding = e > lastE + 1e-6
    if (extruding) {
      const seg = ensureSegment(currentLayer, currentKind)
      const arr = (seg as any)._points as number[]
      arr.push(lastX, lastZ, lastY, x, z, y)
      bboxMin[0] = Math.min(bboxMin[0], lastX, x)
      bboxMin[1] = Math.min(bboxMin[1], lastZ, z)
      bboxMin[2] = Math.min(bboxMin[2], lastY, y)
      bboxMax[0] = Math.max(bboxMax[0], lastX, x)
      bboxMax[1] = Math.max(bboxMax[1], lastZ, z)
      bboxMax[2] = Math.max(bboxMax[2], lastY, y)
    }

    lastX = x
    lastY = y
    lastZ = z
    lastE = e
  }

  for (const layer of layers) {
    if (!layer) continue
    for (const seg of layer.segments) {
      const arr = (seg as any)._points as number[]
      const float = new Float32Array(arr)
      seg.buffer = float.buffer
      seg.vertexCount = float.length / 3
      transfer.push(float.buffer)
      delete (seg as any)._points
    }
  }

  const payload: ResultMessage = {
    type: 'result',
    layers: layers.filter(Boolean),
    bbox: {
      min: [bboxMin[0], bboxMin[1], bboxMin[2]],
      max: [bboxMax[0], bboxMax[1], bboxMax[2]],
    },
  }
  ;(payload as any)._transfer = transfer
  return payload
}

self.onmessage = (event: MessageEvent<ParseMessage>) => {
  const { data } = event
  if (!data || data.type !== 'parse') return
  try {
    // Be tolerant to file naming: pick any .gcode, prefer plate_1.gcode when present
    const zip = unzipSync(new Uint8Array(data.buffer))
    const entries = Object.entries(zip).filter(([name]) => name.toLowerCase().endsWith('.gcode'))
    // Stable preference order
    const preferred = entries.sort((a, b) => {
      const an = a[0].toLowerCase(); const bn = b[0].toLowerCase()
      const as = an.includes('plate_1.gcode') ? 0 : an.includes('plate') ? 1 : 2
      const bs = bn.includes('plate_1.gcode') ? 0 : bn.includes('plate') ? 1 : 2
      return as - bs || an.localeCompare(bn)
    })
    const entry = preferred[0]
    if (!entry) {
      self.postMessage({ type: 'result', layers: [], bbox: { min: [0, 0, 0], max: [0, 0, 0] } })
      return
    }
    const gcodeText = strFromU8(entry[1])
    const parsed = parseGCode(gcodeText)
    if (data.id) parsed.id = data.id
    const transfer = (parsed as any)._transfer as ArrayBuffer[]
    delete (parsed as any)._transfer
    self.postMessage(parsed, transfer)
  } catch (err: any) {
    self.postMessage({ type: 'error', id: data.id, message: err?.message || 'Failed to parse 3MF' })
  }
}
