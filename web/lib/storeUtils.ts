import { Buffer } from 'buffer'

export function toNumber(value: any, fallback = 0): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

export function extensionFromFileName(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

export type UploadAssetKind = 'raw_stl' | 'raw_obj' | 'raw_glb'

export function assetKindFromExtension(ext: string): UploadAssetKind {
  if (ext === 'obj') return 'raw_obj'
  if (ext === 'glb' || ext === 'gltf') return 'raw_glb'
  return 'raw_stl'
}

export function contentTypeFromExtension(ext: string, fallback?: string): string {
  if (ext === 'stl') return 'application/sla'
  if (ext === 'obj') return 'text/plain'
  if (ext === 'glb') return 'model/gltf-binary'
  if (ext === 'gltf') return 'model/gltf+json'
  return fallback || 'application/octet-stream'
}

export function parseDataUrl(value: string | null | undefined): { buffer: Buffer; mime: string; ext: string } | null {
  if (typeof value !== 'string' || !value.startsWith('data:')) return null
  const match = value.match(/^data:(.*?);base64,(.*)$/)
  if (!match) return null
  const mime = match[1] || 'image/png'
  const data = match[2]
  try {
    const buffer = Buffer.from(data, 'base64')
    let ext = 'png'
    if (mime.includes('jpeg')) ext = 'jpg'
    else if (mime.includes('webp')) ext = 'webp'
    else if (mime.includes('png')) ext = 'png'
    return { buffer, mime, ext }
  } catch (error) {
    console.warn('[storeUtils] failed to parse data URL', error)
    return null
  }
}
