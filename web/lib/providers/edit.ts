export interface EditProvider {
  editImage(input: { imageUrl: string; prompt: string; n?: number; format?: 'jpeg'|'png' }): Promise<{ imageUrls: string[]; description?: string }>
}

class FalNanoBanana implements EditProvider {
  private baseUrl: string
  private modelId: string
  private apiKey: string

  constructor() {
    this.baseUrl = (process.env.FAL_BASE_URL || 'https://fal.run').replace(/\/$/, '')
    this.modelId = process.env.EDIT_MODEL_ID || 'fal-ai/nano-banana/edit'
    const key = process.env.FAL_KEY || process.env.FAL_API_KEY
    if (!key) throw new Error('FAL_KEY not set for edit provider')
    this.apiKey = key
  }

  async editImage(input: { imageUrl: string; prompt: string; n?: number; format?: 'jpeg'|'png' }): Promise<{ imageUrls: string[]; description?: string }> {
    const n = Math.max(1, Math.min(4, Number(input.n) || 2))
    const body: any = {
      prompt: input.prompt,
      image_urls: [input.imageUrl],
      num_images: n,
    }
    if (input.format === 'jpeg' || input.format === 'png') body.output_format = input.format
    const url = `${this.baseUrl}/${this.modelId}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`edit_error ${res.status}: ${txt.slice(0,200)}`)
    }
    const data = await res.json().catch(() => ({} as any))
    const imagesArr: any[] = Array.isArray(data.images) ? data.images : []
    const urls = imagesArr.map((x) => (typeof x === 'string' ? x : (x?.url || ''))).filter(Boolean)
    return { imageUrls: urls, description: typeof data.description === 'string' ? data.description : undefined }
  }
}

class StubEditor implements EditProvider {
  async editImage(input: { imageUrl: string; prompt: string; n?: number; format?: 'jpeg'|'png' }): Promise<{ imageUrls: string[]; description?: string }> {
    const n = Math.max(1, Math.min(4, Number(input.n) || 2))
    // Deterministic placeholders derived from the original URL + prompt
    const seed = encodeURIComponent(`${input.imageUrl}|${input.prompt}`)
    const urls = Array.from({ length: n }, (_, i) => `https://picsum.photos/seed/edit-${seed}-${i}/768/768`)
    return { imageUrls: urls, description: 'Edited preview (stub).' }
  }
}

export function getEditProvider(name?: string): EditProvider {
  const provider = (name || process.env.EDIT_PROVIDER || 'fal_nano').toLowerCase()
  switch (provider) {
    case 'fal':
    case 'nano':
    case 'nano-banana':
    case 'fal_nano':
    case 'nano_banana':
      return new FalNanoBanana()
    case 'stub':
    default:
      return new StubEditor()
  }
}

