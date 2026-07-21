import { createAdminClient, normalizeSupabaseUrl, signedUrlWithInfo } from '@/lib/supabaseAdmin'

export type ContextSnapshot = {
  orderId: string
  status: string | null
  quote?: { minutes?: number; grams?: number; price_cents?: number; total_cents?: number } | null
  images: { id: string; url: string; storage_url?: string | null; expires_at?: number | null }[]
  attachments?: {
    asset_id: string
    url: string
    storage_url?: string | null
    expires_at?: number | null
    pending?: boolean
    label?: string | null
    name?: string | null
    size?: number | null
    content_type?: string | null
  }[]
  selected_image_id?: string | null
  chosen_index?: number | null
  angles?: {
    parent_image_id: string
    parent_index?: number | null
    labels: string[]
    image_ids: string[]
    images?: { id: string; url: string; label?: string; storage_url?: string | null; expires_at?: number | null }[]
  }[]
  last_angles_parent_id?: string | null
  geometry?: {
    asset_id?: string | null
    kind?: string | null
    stl_url?: string | null
    storage_url?: string | null
    sha256?: string | null
    expires_at?: number | null
    // viewer-optimized asset (GLB preferred)
    viewer_url?: string | null
    viewer_storage_url?: string | null
    viewer_sha256?: string | null
    viewer_expires_at?: number | null
    viewer_meta?: any
    preview_url?: string | null
    preview_storage_url?: string | null
    preview_expires_at?: number | null
    metrics?: any
  }
  toolpath?: {
    three_mf_url?: string | null
    three_mf_storage_url?: string | null
    three_mf_expires_at?: number | null
    preview_url?: string | null
    preview_storage_url?: string | null
    preview_expires_at?: number | null
  }
  transform?: { target_max_dim_mm?: number | null }
  messages?: {
    id: string
    role: 'user' | 'assistant' | 'tool'
    type?: string | null
    content?: any
    created_at?: string | null
  }[]
  fetched_at?: number
}

export async function buildContextSnapshot(orderId: string, opts?: { maxImages?: number; maxAngles?: number; signTtl?: number }): Promise<ContextSnapshot> {
  const supabase = createAdminClient()
  const signTtl = Math.max(60, Number(opts?.signTtl || process.env.SIGNED_URL_TTL_S || 900))
  const maxImages = Math.max(1, Math.min(8, Number(opts?.maxImages || process.env.CONTEXT_MAX_IMAGES || 4)))
  const maxAngles = Math.max(1, Math.min(6, Number(opts?.maxAngles || process.env.CONTEXT_MAX_ANGLES || 3)))
  const snap: ContextSnapshot = { orderId, status: null, images: [] }
  const { data: order } = await supabase.from('orders').select('id,status,quote_json,chosen_image_id,meta_json').eq('id', orderId).single()
  snap.status = order?.status || null
  snap.quote = (order?.quote_json as any) || null
  snap.selected_image_id = (order?.chosen_image_id as any) || null
  try { snap.chosen_index = (order?.meta_json as any)?.facts?.chosen_index ?? null } catch { snap.chosen_index = null }
  // Recent images (candidates + chosen)
  const { data: imgs } = await supabase
    .from('images')
    .select('id,url,kind,created_at')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true })
    .limit(200)
  const candidates = (imgs || []).filter((x: any) => x.kind === 'candidate' || x.kind === 'chosen')
  const recent = candidates.slice(-maxImages)
  for (const im of recent) {
      const canonical = normalizeSupabaseUrl(im.url) || im.url
      const signed = await signedUrlWithInfo(canonical, signTtl)
      snap.images.push({ id: im.id, url: signed.url, storage_url: canonical, expires_at: signed.expiresAt ?? null })
  }
  // Angles: collect by parent_image_id with labels
  try {
    const { data: angleRows } = await supabase
      .from('images')
      .select('id,url,meta_json,created_at')
      .eq('order_id', orderId)
      .contains('meta_json', { group: 'angles' })
      .order('created_at', { ascending: true })
    const groups: Record<string, any[]> = {}
    let newestParent: { id: string; created_at: string } | null = null
    for (const r of angleRows || []) {
      const parentId = (r as any)?.meta_json?.parent_image_id as string
      if (!parentId) continue
      if (!groups[parentId]) groups[parentId] = []
      groups[parentId].push(r)
      const ca = (r as any)?.created_at as string
      if (!newestParent || (new Date(ca).getTime() > new Date(newestParent.created_at).getTime())) {
        newestParent = { id: parentId, created_at: ca }
      }
    }
    // Map parent id -> candidate index using the latest candidates card
    let indexMap: Record<string, number> = {}
    try {
      const { data: lastCard } = await supabase
        .from('chat_messages')
        .select('content_json')
        .eq('order_id', orderId)
        .eq('type','card.images')
        .order('created_at',{ascending:false})
        .limit(1)
      const arr = (lastCard?.[0]?.content_json?.images || []) as any[]
      for (const it of arr) { if (it?.id && typeof it?.index === 'number') indexMap[it.id] = it.index }
    } catch {}
    snap.angles = []
    for (const [parent, list] of Object.entries(groups)) {
      // Limit to maxAngles images per parent, prefer newest first
      const sorted = list.sort((a:any,b:any)=> new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      const take = sorted.slice(0, maxAngles)
      const labels: string[] = []
      const image_ids: string[] = []
      const images: { id: string; url: string; label?: string; storage_url?: string | null; expires_at?: number | null }[] = []
      for (const r of take) {
        const lab = (r as any)?.meta_json?.angle || null
        let url = r.url
        let signedUrl = url
        let expiresAt: number | null = null
        try {
          const canonical = normalizeSupabaseUrl(r.url) || r.url
          const signed = await signedUrlWithInfo(canonical, signTtl)
          signedUrl = signed.url
          expiresAt = signed.expiresAt ?? null
          url = canonical
        } catch {}
        labels.push(lab || 'angle')
        image_ids.push((r as any).id)
        images.push({ id: (r as any).id, url: signedUrl, label: lab || undefined, storage_url: url, expires_at: expiresAt })
      }
      snap.angles.push({ parent_image_id: parent, parent_index: indexMap[parent] || null, labels, image_ids, images })
    }
    snap.last_angles_parent_id = newestParent?.id || null
  } catch {}
  // Assets: repaired STL, preview(s), 3MF
  const { data: assets } = await supabase
    .from('assets')
    .select('id,kind,url,sha256,meta_json,created_at')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true })
    .limit(300)
  const pickNewest = (arr: any[] | null | undefined, predicate: (a:any)=>boolean) => {
    const list = Array.isArray(arr) ? arr : []
    for (let i = list.length - 1; i >= 0; i--) if (predicate(list[i])) return list[i]
    return null
  }
  const attachmentList: NonNullable<ContextSnapshot['attachments']> = []
  for (const asset of assets || []) {
    if (asset.kind !== 'upload_image') continue
    const meta = (asset.meta_json || {}) as Record<string, any>
    const origin = typeof meta?.origin === 'string' ? meta.origin : null
    if (origin && origin !== 'user_upload') continue
    let canonical = asset.url as string
    try { canonical = normalizeSupabaseUrl(asset.url) || asset.url } catch {}
    let signed: Awaited<ReturnType<typeof signedUrlWithInfo>> | null = null
    try { signed = await signedUrlWithInfo(canonical, signTtl) } catch {}
    attachmentList.push({
      asset_id: asset.id as string,
      url: signed?.url || canonical,
      storage_url: canonical,
      expires_at: signed?.expiresAt ?? null,
      pending: meta?.pending ?? null,
      label: meta?.label ?? null,
      name: meta?.name ?? null,
      size: typeof meta?.size === 'number' ? meta.size : null,
      content_type: meta?.type ?? null,
    })
  }
  if (attachmentList.length) {
    snap.attachments = attachmentList
  }

  const newestRepaired = pickNewest(assets, (a: any) => a.kind === 'repaired_stl')
  const newestSized = pickNewest(assets, (a: any) => a.kind === 'repaired_sized_stl')
  const newestGeomPreview = pickNewest(assets, (a: any) => a.kind === 'geometry_preview_png')
  const newestSlicePreview = pickNewest(assets, (a: any) => a.kind === 'slicer_preview_png')
  const newestThreeMf = pickNewest(assets, (a: any) => a.kind === 'three_mf')
  const newestTransform = pickNewest(assets, (a: any) => a.kind === 'transform')
  const newestViewer = pickNewest(assets, (a: any) => {
    if (a.kind === 'transform') {
      const m = (a.meta_json || {}) as any
      return m?.viewer === true || m?.viewer_glb === true
    }
    // As a generic fallback, allow raw/upload glb as a viewer asset
    return a.kind === 'raw_glb' || a.kind === 'upload_glb'
  })
  const baseMesh = newestSized || newestRepaired
  if (baseMesh) {
    const stlSigned = await signedUrlWithInfo(baseMesh.url, signTtl)
    let viewerSigned: { url: string; expiresAt?: number | null } | null = null
    if (newestViewer) {
      try {
        viewerSigned = await signedUrlWithInfo(newestViewer.url, signTtl)
      } catch {}
    }
    let previewSigned: { url: string; expiresAt?: number | null } | null = null
    if (newestGeomPreview) {
      try {
        previewSigned = await signedUrlWithInfo(newestGeomPreview.url, signTtl)
      } catch {}
    }
    snap.geometry = {
      asset_id: baseMesh.id as string,
      kind: baseMesh.kind,
      stl_url: stlSigned.url,
      storage_url: baseMesh.url,
      sha256: (baseMesh as any)?.sha256 || null,
      expires_at: stlSigned.expiresAt ?? null,
      viewer_url: viewerSigned?.url ?? null,
      viewer_storage_url: newestViewer?.url ?? null,
      viewer_sha256: (newestViewer as any)?.sha256 || null,
      viewer_expires_at: viewerSigned?.expiresAt ?? null,
      viewer_meta: newestViewer?.meta_json ?? null,
      preview_url: previewSigned?.url ?? null,
      preview_storage_url: newestGeomPreview?.url ?? null,
      preview_expires_at: previewSigned?.expiresAt ?? null,
      metrics: baseMesh.meta_json || null,
    }
  }
  if (newestThreeMf || newestSlicePreview) {
    let threeMfSigned: Awaited<ReturnType<typeof signedUrlWithInfo>> | null = null
    if (newestThreeMf) {
      try { threeMfSigned = await signedUrlWithInfo(newestThreeMf.url, signTtl) } catch {}
    }
    let previewSigned: Awaited<ReturnType<typeof signedUrlWithInfo>> | null = null
    if (newestSlicePreview) {
      try { previewSigned = await signedUrlWithInfo(newestSlicePreview.url, signTtl) } catch {}
    }
    snap.toolpath = {
      three_mf_url: threeMfSigned?.url ?? null,
      three_mf_storage_url: newestThreeMf?.url ?? null,
      three_mf_expires_at: threeMfSigned?.expiresAt ?? null,
      preview_url: previewSigned?.url ?? null,
      preview_storage_url: newestSlicePreview?.url ?? null,
      preview_expires_at: previewSigned?.expiresAt ?? null,
    }
  }
  if (newestTransform?.meta_json) {
    const tmeta = newestTransform.meta_json as any
    snap.transform = { target_max_dim_mm: Number(tmeta?.target_max_dim_mm) || null }
  }

  try {
    const { data: chatRows } = await supabase
      .from('chat_messages')
      .select('id,role,type,content_json,created_at')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true })
      .limit(400)
    if (chatRows && chatRows.length) {
      const processed = [] as ContextSnapshot['messages']
      for (const row of chatRows) {
        const role = (row.role as 'user' | 'assistant' | 'tool') || 'assistant'
        const type = row.type || null
        let content = row.content_json
        try {
          if (role === 'assistant' && type === 'card.images' && Array.isArray(content?.images)) {
            const imgs = [] as any[]
            for (const img of content.images) {
      const canonical = normalizeSupabaseUrl(img?.url) || img?.url || null
      if (!canonical) continue
      const signed = await signedUrlWithInfo(canonical, signTtl)
      imgs.push({ ...img, url: signed.url, storage_url: canonical, expires_at: signed.expiresAt ?? null })
            }
            content = { ...content, images: imgs }
          } else if (role === 'assistant' && type === 'viewer.focus' && content?.url) {
        const canonical = normalizeSupabaseUrl(content.url) || content.url
        const signed = await signedUrlWithInfo(canonical, signTtl)
        content = {
          ...content,
          url: signed.url,
          storage_url: canonical,
          expires_at: signed.expiresAt ?? null,
        }
          } else if (role === 'assistant' && type === 'card.job' && content?.images) {
            const imgs = [] as any[]
            for (const img of content.images) {
              const signed = await signedUrlWithInfo(img?.url, signTtl)
              imgs.push({ ...img, url: signed.url, storage_url: img?.url ?? null, expires_at: signed.expiresAt ?? null })
            }
            content = { ...content, images: imgs }
          }
        } catch {}
        processed?.push({
          id: row.id as string,
          role,
          type,
          content,
          created_at: row.created_at || null,
        })
      }
      snap.messages = processed
    }
  } catch {}
  snap.fetched_at = Date.now()
  return snap
}
