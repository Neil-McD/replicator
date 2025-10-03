export type T2IStyle = 'figurine' | 'mechanical' | 'organic' | string

const ARCHITECTURE_KEYWORDS = [
  'architecture',
  'architectural',
  'architect',
  'building',
  'house',
  'home',
  'residence',
  'villa',
  'floor plan',
  'floorplan',
  'facade',
  'façade',
  'structure',
  'pavilion',
  'skyscraper',
  'tower',
]

function isArchitecturalStyle(style?: T2IStyle, prompt?: string) {
  const blob = `${style || ''} ${prompt || ''}`.toLowerCase()
  return ARCHITECTURE_KEYWORDS.some((keyword) => blob.includes(keyword))
}

function parseOptionalNumber(value: string | number | null | undefined): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export interface T2IProvider {
  generateImages(input: { prompt: string; n: number; style?: T2IStyle; seed?: number }): Promise<{ imageUrls: string[] }>
}

function normalizeFalModelId(value: string): string {
  let s = (value || '').trim()
  if (!s) return ''
  s = s.replace(/^"|"$/g, '').replace(/^'|'$/g, '')
  s = s.replace(/^\/+/, '')
  s = s.replace(/\/(generate|invoke|run|call)\/?$/i, '')
  const lower = s.toLowerCase()
  if (!lower || lower === 'generate' || lower === '/generate') return 'fal-ai/nano-banana'
  if (lower === 'nano-banana/generate' || lower === '/nano-banana/generate') return 'fal-ai/nano-banana'
  if (lower === 'fal-ai/nano-banana' || lower === 'nano-banana') return 'fal-ai/nano-banana'
  return s
}

function buildSystemPrefix(style?: T2IStyle, prompt?: string) {
  // New defaults (engineered for I→3D):
  // - Neutral studio scene with strong silhouette and minimal perspective
  // - Print‑friendly geometry cues (fused base, chunky features, no floaters)
  const core = (process.env.T2I_SYSTEM_PREFIX || `a single product concept and one object, centered and fully in frame; exactly one object (no duplicates, not a set); neutral mid-gray seamless background; allow the form to speak for itself; product-render aesthetic; telephoto feel (minimal perspective ~70–85mm); no props; no hands/people; no text/logos/watermarks`).trim()
  const lighting = (process.env.T2I_SYSTEM_LIGHTING || `soft three-point studio light (key at 45°, gentle fill, subtle rim); daylight ~5600K; soft ground-plane shadow; clean highlights that reveal the silhouette`).trim()
  const printability = (process.env.T2I_SYSTEM_PRINTABILITY || `single solid object with a stable base or integrated stand; features ≥1.6 mm; all elements remain fused; nothing floating or disconnected`).trim()
  // Keep surfaces clean for I→3D without forcing decorative detail.
  const surface = (process.env.T2I_SYSTEM_SURFACE || `overall clean surfaces; allow the model to introduce detail naturally; avoid blueprint lines, wireframes, contour hatching, or technical overlays`).trim()
  const base = `${core}; ${lighting}; ${printability}; ${surface}`
  const s = String(style || '').toLowerCase()
  const isArch = isArchitecturalStyle(style, prompt)
  if (isArch) {
    const archCore = (process.env.T2I_SYSTEM_ARCHITECTURE || `architectural concept visualization focused on a single exterior structure; dramatic brutalist/modernist massing with cantilevered or interlocking volumes; celebrate strong silhouettes in concrete, glass, and steel; omit surrounding neighborhood or props`).trim()
    const archLighting = (process.env.T2I_SYSTEM_ARCHITECTURE_LIGHTING || `cinematic dusk or golden-hour lighting with soft sky bounce, deep shadows, and controlled rim light; subtle interior glow to reveal depth`).trim()
    const archStructure = (process.env.T2I_SYSTEM_ARCHITECTURE_STRUCTURE || `ensure print-friendly structural logic: cantilevers remain counterbalanced, supports are continuous, and a solid podium or plinth keeps the model flush with the build plate`).trim()
    const archSurface = (process.env.T2I_SYSTEM_ARCHITECTURE_SURFACE || `crisp planar surfaces, layered facade treatments, recessed glazing, and scored concrete; no cartoon outlines, blueprint lines, diagram labels, landscaping, or floating context`).trim()
    const archCamera = (process.env.T2I_SYSTEM_ARCHITECTURE_CAMERA || `camera positioned slightly above the roofline at a three-quarter corner (looking down ~15–20°); mild telephoto compression (60–75 mm). Present on a neutral studio plinth with a subtle mm-grid or matte gradient plane.`).trim()
    return `${archCore}; ${archLighting}; ${archStructure}; ${archSurface}; ${archCamera}`
  }
  // Optional style-specific guidance (overridable via env)
  const mech = process.env.T2I_SYSTEM_MECHANICAL || `hard‑surface industrial look; matte gray PLA‑like plastic; crisp chamfers/fillets; minimal panel seams; front three‑quarter primary angle`
  const fig = process.env.T2I_SYSTEM_FIGURINE || `standing figure on a simple round base; neutral/relaxed pose; three‑quarter angle; gentle rim light; smooth surfaces; no weapons or IP`
  const org = process.env.T2I_SYSTEM_ORGANIC || `single smooth form; continuous surfaces; subtle curvature; minimal fine texture; no grooves or seam lines; three‑quarter angle`
  if (s.includes('mechanical')) return `${base}; ${mech}`
  if (s.includes('figurine')) return `${base}; ${fig}`
  if (s.includes('organic')) return `${base}; ${org}`
  return base
}

function buildNegativePrompt(style?: T2IStyle, prompt?: string) {
  // Strong, centralized negatives to enforce a single subject per frame.
  // If T2I_NEGATIVE is provided, it overrides this default.
  const env = (process.env.T2I_NEGATIVE || '').trim()
  if (env) return env

  const isArch = isArchitecturalStyle(style, prompt)

  // Architectural pass keeps the frame clean without flattening the geometry.
  if (isArch) {
    const archBase = [
      'interior view', 'section drawing', 'elevation drawing', 'floor plan diagram', 'axonometric projection', 'wireframe', 'blueprint lines',
      'city skyline', 'street scene', 'people', 'cars', 'trees', 'landscape context', 'neighborhood',
      'text', 'labels', 'watermark', 'logo',
      'overexposed sky', 'heavy motion blur', 'cartoon style', 'hand drawn sketch', 'low poly game asset',
    ]
    const archExtra = (process.env.T2I_NEGATIVE_ARCHITECTURE_EXTRA || '').trim()
    const archMerged = archExtra ? archBase.concat(archExtra.split(',').map((s) => s.trim()).filter(Boolean)) : archBase
    return archMerged.join(', ')
  }

  // Default tuned for product-like concepts: minimizes sets, duplicates, and props.
  const base = [
    // Single subject only
    'multiple objects', 'set of objects', 'collection', 'assortment', 'group', 'crowded', 'duplicates', 'several items', 'pile',
    // Absolutely no multi-view or panels
    'multi view', 'multi-view', 'multi angle', 'multi-angle', 'split view', 'split-screen', 'triptych', 'diptych', 'collage', 'montage', 'grid', 'panel', 'panels', 'blueprint sheet', 'orthographic views', 'front view and side view', 'front/side/top', 'three views', 'view labels', 'captioned views',
    // No technical drawings or blueprints
    'exploded view', 'cutaway', 'blueprint', 'technical drawing', 'diagram', 'schematic', 'CAD drawing',
    // Strong line-art suppression (prevents false cut lines and support-inducing seams)
    'wireframe', 'line art', 'lineart', 'outlines', 'contour lines', 'hatching', 'cross-hatching', 'sketch', 'doodle', 'comic style', 'manga style', 'cel shading', 'toon outline', 'edge map', 'depth map',
    // No patterns that create surface artifacts
    'grid texture', 'checkered', 'striped pattern', 'plaid', 'moire', 'halftone', 'noise pattern', 'sticker', 'decals',
    // No text or labels
    'text', 'label', 'labels', 'logo', 'watermark',
    // No people or props
    'people', 'hands', 'props', 'background objects',
    // Common “context” items that tend to sneak in and create a set-like scene
    'pencils', 'pens', 'brushes', 'utensils', 'tools', 'phone', 'key', 'book', 'paper', 'ruler',
  ]
  const extra = (process.env.T2I_NEGATIVE_EXTRA || '').trim()
  const merged = extra ? base.concat(extra.split(',').map((s) => s.trim()).filter(Boolean)) : base
  return merged.join(', ')
}

function composePrompt(userPrompt: string, style?: T2IStyle) {
  const sys = buildSystemPrefix(style, userPrompt)
  const styleHint = style ? `(style: ${style})` : ''
  const isArch = isArchitecturalStyle(style, userPrompt)
  if (isArch) {
    const enforce = 'Single exterior structure only, staged on a clean podium or ground plane; no surrounding buildings, people, landscaping, or streets. Encourage bold brutalist/modernist massing with cantilevered or interlocking volumes that remain structurally sound.'
    const cleanup = 'highlight recessed glazing, terraces, ribbed concrete, and layered facade systems; ensure watertight geometry with a continuous base; present from a slightly elevated three-quarter top-corner view looking downward against a neutral studio gradient or fine mm-grid floor.'
    return `${sys}. ${userPrompt}. ${enforce} ${cleanup} ${styleHint}`.trim()
  }
  // Enforce single-object composition explicitly in the actual prompt text as well.
  const enforce = 'One isolated object only — not a set, not multiple, no accessories; show only the product.'
  const cleanup = 'feel free to explore the shape as long as everything remains connected and printable; avoid floating parts, loose scraps, wireframe overlays, or blueprint contour lines.'
  return `${sys}. ${userPrompt}. ${enforce} ${cleanup} ${styleHint}`.trim()
}

class FalFluxT2I implements T2IProvider {
  private modelId: string
  private baseUrl: string
  private fallbackModels: string[]

  constructor() {
    // Resolve model id robustly from env and provider.
    const providerHint = (process.env.T2I_PROVIDER || '').toLowerCase()
    const rawId = (process.env.FAL_MODEL_ID || '').trim()
    const chosen = normalizeFalModelId(rawId)
    // Default by provider: nano -> nano-banana; otherwise flux/dev
    const fallback = providerHint.includes('nano') ? 'fal-ai/nano-banana' : 'fal-ai/flux/dev'
    this.modelId = chosen || fallback
    this.baseUrl = (process.env.FAL_BASE_URL || 'https://fal.run').replace(/\/$/, '')
    const fallbackList = [
      this.modelId,
      normalizeFalModelId(process.env.FAL_FALLBACK_MODEL_ID || ''),
      ...(process.env.FAL_FALLBACK_MODELS || '')
        .split(',')
        .map((m) => normalizeFalModelId(m))
        .filter(Boolean),
      providerHint.includes('nano') ? 'fal-ai/flux/dev' : 'fal-ai/nano-banana',
      'fal-ai/flux/dev',
      'fal-ai/flux-pro',
      'fal-ai/flux-pro/v1.1',
      'fal-ai/nano',
      'fal-ai/nano-banana',
    ].filter(Boolean)
    const seen = new Set<string>()
    this.fallbackModels = []
    for (const mid of fallbackList) {
      const cleaned = normalizeFalModelId(mid)
      if (!cleaned || seen.has(cleaned)) continue
      seen.add(cleaned)
      this.fallbackModels.push(cleaned)
    }
    if ((process.env.DEBUG_T2I || process.env.FAL_DEBUG || '').toString().trim().toLowerCase() in { '1':1,'true':1,'yes':1 }) {
      // Log resolved endpoint once at construction time
      // eslint-disable-next-line no-console
      console.log(`[t2i] endpoint=${this.baseUrl}/${this.modelId}`)
    }
  }

  async generateImages(input: { prompt: string; n: number; style?: T2IStyle; seed?: number }): Promise<{ imageUrls: string[] }> {
    const fallbackStub = async () => {
      const stub = new StubT2I()
      return stub.generateImages(input)
    }
    const falKey = process.env.FAL_KEY || process.env.FAL_API_KEY
    if (!falKey) throw new Error('FAL_KEY not set')
    const requested = Math.max(1, Math.min(8, Number(input.n) || 6))
    // Default style can be controlled via env; helps bias toward organic forms by default
    const defaultStyle = (process.env.T2I_DEFAULT_STYLE || '').trim() as T2IStyle
    const style = input.style || (defaultStyle ? defaultStyle : undefined)
    const maxPerCall = Number(process.env.FAL_MAX_IMAGES || 4)
    const n = Math.min(maxPerCall, requested)
    const isArch = isArchitecturalStyle(style, input.prompt)
    const basePrompt = composePrompt(input.prompt, style)
    const url = `${this.baseUrl}/${this.modelId}`
    const negative = buildNegativePrompt(style, input.prompt)
    // Always generate a single camera view per image; disable any multi‑angle fan mode
    const multiAngle = false

    const archStepsEnv = parseOptionalNumber(process.env.T2I_ARCHITECTURE_STEPS)
    const archCfgEnv = parseOptionalNumber(process.env.T2I_ARCHITECTURE_CFG)
    const archSeedEnv = parseOptionalNumber(process.env.T2I_ARCHITECTURE_SEED)

    const applyArchitectureDefaults = (target: Record<string, any>, seedOffset = 0) => {
      if (!isArch) return
      if (archStepsEnv !== null) target.num_inference_steps = archStepsEnv
      else if (!process.env.FAL_STEPS && target.num_inference_steps === undefined) target.num_inference_steps = 28
      if (archCfgEnv !== null) target.guidance_scale = archCfgEnv
      else if (!process.env.FAL_CFG && target.guidance_scale === undefined) target.guidance_scale = 9
      if (archSeedEnv !== null && target.seed === undefined) target.seed = archSeedEnv + seedOffset
    }

    // Post helper with provider fallback: try configured model first, then Nano Banana on soft errors
    const tryModels = async (modelIds: string[], body: any): Promise<string> => {
      const errors: string[] = []
      for (const mid of modelIds) {
        const url1 = `${this.baseUrl}/${mid}`
        try {
          const res = await fetch(url1, {
            method: 'POST',
            headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (!res.ok) {
            const txt = await res.text().catch(() => '')
            errors.push(`(${mid}) ${res.status}:${txt.slice(0,200)}`)
            continue
          }
          const data = await res.json().catch(() => ({} as any))
          const arr = (data.images || data.output?.images || data.assets || data.result || []) as any[]
          const urls = (Array.isArray(arr) ? arr : []).map((x) => (typeof x === 'string' ? x : (x?.url || x?.href || x?.signed_url || ''))).filter(Boolean)
          if (urls[0]) return urls[0]
          errors.push(`(${mid}) empty_result`)
        } catch (e: any) {
          errors.push(`(${mid}) ${e?.message || 'error'}`)
        }
      }
      throw new Error(`fal_flux_error 422: ${errors.join(' | ')}`)
    }

    try {
      // If angle variety is enabled, make N single-image calls with angle hints.
      if (multiAngle) {
        const ANGLES = [
          'front three-quarter view',
          'left three-quarter view',
        'right three-quarter view',
        'rear three-quarter view',
        'high three-quarter view',
      ]
      const k = Math.min(n, ANGLES.length)
      const tasks = ANGLES.slice(0, k).map((angle) => {
        const p = `${basePrompt}. camera: ${angle}; simple ground-plane shadow.`
        const body: any = {
          prompt: p,
          num_images: 1,
          negative_prompt: negative,
          negative_prompt_text: negative,
          disable_collage: true,
          disable_grid: true,
        }
        if (!isArch) {
          body.single_object = true
          body.avoid_multiple_subjects = true
          body.composition = 'single subject'
          body.subject_count = 1
        } else {
          body.presentation = 'architecture concept'
          body.subject_count = 1
        }
        if (process.env.FAL_IMAGE_SIZE) body.image_size = process.env.FAL_IMAGE_SIZE
        if (process.env.FAL_STEPS) body.num_inference_steps = Number(process.env.FAL_STEPS)
        if (process.env.FAL_CFG) body.guidance_scale = Number(process.env.FAL_CFG)
        applyArchitectureDefaults(body, ANGLES.indexOf(angle))
        if (process.env.FAL_SEED) body.seed = Number(process.env.FAL_SEED) + ANGLES.indexOf(angle)
        return tryModels(this.fallbackModels, body).catch(() => null)
      })
      const results = await Promise.all(tasks)
      const imageUrls = results.filter(Boolean) as string[]
      if (!imageUrls.length) throw new Error('fal_flux_no_images')
      return { imageUrls }
    }
      // Single-call, multi-image path (default)
      const body: any = {
        prompt: basePrompt,
        num_images: n,
        negative_prompt: negative,
        negative_prompt_text: negative,
        disable_collage: true,
        disable_grid: true,
      }
      if (!isArch) {
        body.single_object = true
        body.avoid_multiple_subjects = true
        body.composition = 'single subject'
        body.subject_count = 1
      } else {
        body.presentation = 'architecture concept'
        body.subject_count = 1
      }
      // Optional sane defaults; FAL will ignore unknowns
      if (process.env.FAL_IMAGE_SIZE) body.image_size = process.env.FAL_IMAGE_SIZE // e.g., square_hd
      if (process.env.FAL_STEPS) body.num_inference_steps = Number(process.env.FAL_STEPS)
      if (process.env.FAL_CFG) body.guidance_scale = Number(process.env.FAL_CFG)
      applyArchitectureDefaults(body)
      if (typeof input.seed === 'number' && Number.isFinite(input.seed)) body.seed = Number(input.seed)
      else if (process.env.FAL_SEED) body.seed = Number(process.env.FAL_SEED)

      if ((process.env.DEBUG_T2I || process.env.FAL_DEBUG || '').toString().trim().toLowerCase() in { '1':1,'true':1,'yes':1 }) {
        // eslint-disable-next-line no-console
        console.log(`[t2i] POST ${url}`)
      }
      // Try configured model first; cascade through healthy fallbacks
      const firstOne = await tryModels(this.fallbackModels, body)
      const imageUrls: string[] = firstOne ? [firstOne] : []
      while (imageUrls.length < n) {
        try {
          const u = await tryModels(this.fallbackModels, { ...body, num_images: 1 })
          if (u) imageUrls.push(u)
          else break
        } catch {
          break
        }
      }
      if (!imageUrls.length) throw new Error('fal_flux_no_images')
      return { imageUrls }
    } catch (err) {
      console.warn('[t2i] fal provider failed; falling back to stub', err)
      return fallbackStub()
    }
  }
}

class StubT2I implements T2IProvider {
  async generateImages(input: { prompt: string; n: number; style?: T2IStyle }): Promise<{ imageUrls: string[] }> {
    const n = Math.max(1, Math.min(2, Number(input.n) || 2))
    // Deterministic placeholder images seeded by composed prompt
    const composed = composePrompt(input.prompt, input.style)
    const seedBase = encodeURIComponent(composed)
    const urls = Array.from({ length: n }, (_, i) => `https://picsum.photos/seed/${seedBase}-${i}/768/768`)
    return { imageUrls: urls }
  }
}

export function getT2IProvider(name?: string): T2IProvider {
  const provider = (name || process.env.T2I_PROVIDER || 'stub').toLowerCase()
  switch (provider) {
    case 'fal':
    case 'flux':
    case 'fal-flux':
      return new FalFluxT2I()
    case 'nano':
    case 'nano-banana':
    case 'fal_nano':
    case 'nano_banana':
      return new FalFluxT2I()
    case 'stub':
    default:
      return new StubT2I()
  }
}
