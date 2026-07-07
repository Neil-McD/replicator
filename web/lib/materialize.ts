import type { SupabaseClient } from '@supabase/supabase-js'

import { ensureStorageBucket, signedUrlOrDirect } from '@/lib/supabaseAdmin'
import { attachQuickMesh } from '@/lib/providers/i23d'
import { getEditProvider } from '@/lib/providers/edit'
import { mirrorRemoteImageToStorage } from '@/lib/storage'
import { robustImageFetch } from '@/lib/httpFetch'
import { transitionOrder } from '@/lib/orderState'

type UploadResult = { id: string; assetUrl: string; viewRole?: string | null }

export type MaterializeOptions = {
  supabase: SupabaseClient<any, any, any>
  orderId: string
  imageIds?: string[]
  imageUrls?: string[]
  autoAngles?: boolean
  enableQuickMesh?: boolean
}

export type MaterializeResult = {
  uploaded: UploadResult[]
  chosenImageId: string | null
  quickMesh?: { kind: string; url: string } | null
  angleImages?: UploadResult[]
}

const RAW_MESH_KINDS = new Set(['raw_glb', 'raw_obj', 'raw_stl'])

function normalizeViewRole(role?: string | null): string | null {
  if (!role) return null
  const norm = role.trim().toLowerCase()
  if (!norm) return null
  if (norm === 'opposite' || norm === 'rear') return 'back'
  if (norm === 'side') return 'right'
  const allowed = ['front', 'back', 'left', 'right', 'top', 'bottom']
  return allowed.includes(norm) ? norm : null
}

async function mergeOrderFacts(
  supabase: SupabaseClient<any, any, any>,
  orderId: string,
  facts: Record<string, any>
) {
  const payload = { p_order_id: orderId, p_facts: facts }
  const { error } = await supabase.rpc('merge_order_facts', payload)
  if (error) throw error
}

async function shouldSkipQuickMesh(
  supabase: SupabaseClient<any, any, any>,
  orderId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('assets')
    .select('id, kind')
    .eq('order_id', orderId)
    .in('kind', Array.from(RAW_MESH_KINDS))
    .order('created_at', { ascending: false })
    .limit(1)
  return !!(data && data.length)
}

async function resolveImageIds(
  supabase: SupabaseClient<any, any, any>,
  orderId: string,
  imageIds: string[],
  imageUrls: string[]
): Promise<string[]> {
  if (imageIds.length) return imageIds
  if (!imageUrls.length) return []
  const { data } = await supabase
    .from('images')
    .select('id')
    .eq('order_id', orderId)
    .in('url', imageUrls)
  return (data || []).map((row) => row.id as string)
}

async function fetchImages(
  supabase: SupabaseClient<any, any, any>,
  orderId: string,
  ids: string[]
) {
  if (!ids.length) return []
  const { data, error } = await supabase
    .from('images')
    .select('id, url, meta_json')
    .eq('order_id', orderId)
    .in('id', ids)
  if (error) throw error
  const rows = data || []
  const found = new Set(rows.map((row: any) => row.id as string))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length) throw new Error('image_not_found')
  return rows
}

function includeAngleParents(rows: any[]): Set<string> {
  const wanted = new Set<string>()
  for (const row of rows) {
    wanted.add(row.id)
    const meta = (row?.meta_json || {}) as Record<string, any>
    if (meta?.group === 'angles' && typeof meta?.parent_image_id === 'string') {
      wanted.add(meta.parent_image_id)
    }
  }
  return wanted
}

function computeViewRoles(rows: any[]): { id: string; url: string; meta: any; viewRole: string | null }[] {
  return rows.map((row, index) => {
    const meta = (row?.meta_json || {}) as Record<string, any>
    const explicit = normalizeViewRole(meta.view_role)
    let derived = explicit
    if (!derived && meta.group === 'angles' && typeof meta.angle === 'string') {
      derived = normalizeViewRole(meta.angle)
    }
    if (!derived && index === 0) derived = 'front'
    return { id: row.id as string, url: row.url as string, meta, viewRole: derived }
  })
}

async function uploadImage(
  supabase: SupabaseClient<any, any, any>,
  orderId: string,
  bucket: string,
  id: string,
  url: string,
  viewRole?: string | null,
  meta?: Record<string, any>
): Promise<UploadResult | null> {
  try {
    let srcUrl = url
    try {
      // Preserve supabase:// signing, pass-through remote URLs
      srcUrl = await signedUrlOrDirect(url)
    } catch {}
    const fetched = await robustImageFetch(srcUrl)
    const b = Buffer.from(fetched.ab)
    const ct = (fetched.contentType || 'image/jpeg').toLowerCase()
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg'
    const name = `${Date.now()}-${id}.${ext}`
    const path = `uploads/${orderId}/${name}`
    const { error } = await supabase.storage.from(bucket).upload(path, b, {
      upsert: true,
      contentType: ct,
    })
    if (error) throw error
    const supaUrl = `supabase://${bucket}/${path}`
    const metaJson = {
      ...(meta || {}),
      src: url,
      view_role: viewRole || meta?.view_role || null,
      image_id: id,
      origin: 'concept_mirror',
    }
    await supabase
      .from('assets')
      .insert({ order_id: orderId, kind: 'upload_image', url: supaUrl, meta_json: metaJson })
    return { id, assetUrl: supaUrl, viewRole: viewRole || null }
  } catch (err) {
    // Enrich diagnostics on failure to mirror
    const host = (() => {
      try {
        return new URL(url).host
      } catch {
        return null
      }
    })()
    const message = `upload_error:${id}:${(err as Error).message}`
    const meta_json = {
      image_id: id,
      source_url: url,
      host,
      hint: 'server_fetch_mirror_failed',
      attempts: (err as any)?.attempts ?? null,
      usedReferer: (err as any)?.usedReferer ?? null,
    }
    try {
      await supabase
        .from('order_events')
        .insert({ order_id: orderId, phase: 'materializing', message, meta_json })
    } catch {}
    return null
  }
}

export async function materializeSelectedImages(options: MaterializeOptions): Promise<MaterializeResult> {
  const { supabase, orderId, autoAngles = true, enableQuickMesh = false } = options
  // Clear cancel flag on new materialize intent to let worker proceed if a prior refresh set it
  try {
    const { data: row } = await supabase.from('orders').select('meta_json').eq('id', orderId).single()
    const prev = (row?.meta_json as any) || {}
    const next = { ...(typeof prev === 'object' && prev ? prev : {}), cancel_requested: false }
    await supabase.from('orders').update({ meta_json: next }).eq('id', orderId)
  } catch {}
  const baseIds = options.imageIds ?? []
  const imageIds = await resolveImageIds(supabase, orderId, baseIds, options.imageUrls ?? [])
  if (!imageIds.length) {
    throw new Error('imageIds required')
  }

  let rows = await fetchImages(supabase, orderId, imageIds)
  if (!rows.length) throw new Error('no_images_found')

  const wantedIds = Array.from(includeAngleParents(rows))
  if (wantedIds.length !== rows.length) {
    const extras = await fetchImages(supabase, orderId, wantedIds)
    if (extras.length) rows = extras
  }

  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'artifacts'
  await ensureStorageBucket(bucket)

  const initialImages = computeViewRoles(rows)
  const uploaded: UploadResult[] = []
  for (const im of initialImages) {
    const upload = await uploadImage(supabase, orderId, bucket, im.id, im.url, im.viewRole, im.meta)
    if (upload) uploaded.push(upload)
  }
  if (!uploaded.length) {
    // Fallback: enqueue generation using original image URLs (remote), so the worker can
    // attempt to download directly. Improves resilience when mirroring is blocked.
    const fallbackViews = initialImages.map((im) => ({ imageId: im.id, assetUrl: im.url, viewRole: im.viewRole || null }))
    try {
      const hosts = Array.from(
        new Set(
          fallbackViews
            .map((v) => {
              try { return new URL(v.assetUrl as string).host } catch { return null }
            })
            .filter(Boolean) as string[],
        ),
      )
      await supabase
        .from('order_events')
        .insert({ order_id: orderId, phase: 'materializing', message: `materialize_fallback_remote:${fallbackViews.length}`, meta_json: { hosts } })
    } catch {}
    const existingTask = await supabase
      .from('generation_tasks')
      .select('id')
      .eq('order_id', orderId)
      .eq('kind', 'i23d')
      .in('status', ['queued', 'running'])
      .limit(1)
    if (!existingTask.data?.length) {
      const taskKey = `i23d:${orderId}:${fallbackViews.map((v) => v.imageId).sort().join(',')}:worker`
      await supabase.from('generation_tasks').insert({
        order_id: orderId,
        kind: 'i23d',
        provider: 'worker',
        status: 'queued',
        idempotency_key: taskKey,
        payload_json: {
          imageAssetUrls: fallbackViews.map((v) => v.assetUrl),
          imageIds: fallbackViews.map((v) => v.imageId),
          imageViews: fallbackViews,
        },
      })
    }
    await transitionOrder(supabase, {
      orderId,
      to: 'materializing',
      authority: 'materialize',
      expectedFrom: ['await_image_pick', 'materializing'],
      idempotencyKey: `materialize:${orderId}:${fallbackViews.map((v) => v.imageId).sort().join(',')}:worker`,
      meta: { selected_image_ids: fallbackViews.map((v) => v.imageId), remote_fallback: true },
    })
    await supabase
      .from('order_events')
      .insert({ order_id: orderId, phase: 'materializing', message: `Selected ${fallbackViews.length} image(s) (remote fallback)` })
    return { uploaded: [], chosenImageId: initialImages[0]?.id || null, quickMesh: null, angleImages: [] }
  }

  await supabase.from('images').update({ kind: 'chosen' }).in('id', uploaded.map((u) => u.id))
  for (const item of uploaded) {
    if (!item.viewRole) continue
    const baseMeta = initialImages.find((im) => im.id === item.id)?.meta || {}
    const nextMeta = { ...baseMeta, view_role: item.viewRole }
    await supabase.from('images').update({ meta_json: nextMeta }).eq('id', item.id)
  }

  const chosenId = uploaded[0]?.id || null
  if (chosenId) {
    await supabase.from('orders').update({ chosen_image_id: chosenId }).eq('id', orderId)
  }
  const lastCard = await supabase
    .from('chat_messages')
    .select('content_json')
    .eq('order_id', orderId)
    .eq('type', 'card.images')
    .order('created_at', { ascending: false })
    .limit(1)
  const idx = lastCard.data?.[0]?.content_json?.images?.find?.((item: any) => item.id === chosenId)?.index
  if (idx) {
    await mergeOrderFacts(supabase, orderId, { chosen_index: idx, chosen_image_id: chosenId })
  }

  const existingTask = await supabase
    .from('generation_tasks')
    .select('id')
    .eq('order_id', orderId)
    .eq('kind', 'i23d')
    .in('status', ['queued', 'running'])
    .limit(1)
  if (!existingTask.data?.length) {
    const taskKey = `i23d:${orderId}:${uploaded.map((u) => u.id).sort().join(',')}:worker`
    await supabase.from('generation_tasks').insert({
      order_id: orderId,
      kind: 'i23d',
      provider: 'worker',
      status: 'queued',
      idempotency_key: taskKey,
      payload_json: {
        imageAssetUrls: uploaded.map((u) => u.assetUrl),
        imageIds: uploaded.map((u) => u.id),
        imageViews: uploaded.map((u) => ({ imageId: u.id, assetUrl: u.assetUrl, viewRole: u.viewRole || null })),
      },
    })
  }

  await transitionOrder(supabase, {
    orderId,
    to: 'materializing',
    authority: 'materialize',
    expectedFrom: ['await_image_pick', 'materializing'],
    idempotencyKey: `materialize:${orderId}:${uploaded.map((u) => u.id).sort().join(',')}:worker`,
    meta: { selected_image_ids: uploaded.map((u) => u.id) },
  })
  await supabase
    .from('order_events')
    .insert({ order_id: orderId, phase: 'materializing', message: `Selected ${uploaded.length} image(s)` })

  let autoAngleUploads: UploadResult[] = []
  if (autoAngles && uploaded[0]) {
    const autoAngleList = (process.env.I23D_AUTO_ANGLES || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .map((s) => (s === 'opposite' ? 'back' : s))
      .filter((s) => ['back', 'left', 'right', 'top', 'bottom'].includes(s))
    if (autoAngleList.length) {
      const editor = (() => {
        try {
          return getEditProvider(process.env.EDIT_PROVIDER)
        } catch (err) {
          console.warn('[materialize] edit provider unavailable', err)
          return null
        }
      })()
      if (editor) {
        const parent = uploaded[0]
        const { data: existingAngles } = await supabase
          .from('images')
          .select('id, url, meta_json')
          .eq('order_id', orderId)
          .contains('meta_json', { parent_image_id: parent.id, group: 'angles' })
        const haveAngles = new Set<string>()
        if (existingAngles) {
          for (const row of existingAngles) {
            const angle = normalizeViewRole(row.meta_json?.angle) || normalizeViewRole(row.meta_json?.view_role)
            if (angle) haveAngles.add(angle)
            const mirrored = { id: row.id as string, assetUrl: row.url as string, viewRole: angle }
            autoAngleUploads.push(mirrored)
          }
        }
        const neededAngles = autoAngleList.filter((angle) => !haveAngles.has(angle)) as Array<'back' | 'left' | 'right' | 'top' | 'bottom'>
        if (neededAngles.length) {
          const parentSigned = await signedUrlOrDirect(parent.assetUrl)
          for (const angle of neededAngles) {
            const prompts: Record<typeof angle, string> = {
              back: 'same object and style; rotate camera to show the rear perspective; centered; neutral studio background; single object; no props; no text.',
              left: 'same object and style; rotate camera to the left profile view; centered; neutral studio background; single object; no props; no text.',
              right: 'same object and style; rotate camera to the right profile view; centered; neutral studio background; single object; no props; no text.',
              top: 'same object and style; change only the camera to a straight top-down view; centered; neutral studio background; no props; no text.',
              bottom: 'same object and style; show the underside/low angle; centered; neutral studio background; no props; no text.',
            }
            try {
              const { imageUrls } = await editor.editImage({ imageUrl: parentSigned, prompt: prompts[angle], n: 1, format: 'jpeg' })
              const url = imageUrls?.[0]
              if (!url) continue
              const mirrored = await mirrorRemoteImageToStorage(supabase, url, {
                bucket,
                prefix: `angles/${orderId}`,
              })
              const { data: inserted } = await supabase
                .from('images')
                .insert({
                  order_id: orderId,
                  kind: 'candidate',
                  url: mirrored,
                  meta_json: { parent_image_id: parent.id, group: 'angles', angle, view_role: angle },
                })
                .select('id')
                .single()
              if (inserted?.id) {
                await supabase.from('assets').insert({
                  order_id: orderId,
                  kind: 'upload_image',
                  url: mirrored,
                  meta_json: { parent_image_id: parent.id, angle, view_role: angle, image_id: inserted.id, origin: 'concept_mirror' },
                })
                autoAngleUploads.push({ id: inserted.id, assetUrl: mirrored, viewRole: angle })
              }
            } catch (angleErr) {
              console.warn('[materialize] auto-angle generation failed', angle, angleErr)
            }
          }
          if (autoAngleUploads.length) {
            uploaded.push(...autoAngleUploads.map((a) => ({ ...a })))
            await supabase.from('images').update({ kind: 'chosen' }).in('id', autoAngleUploads.map((a) => a.id))
          }
        }
      }
    }
  }

  let quickMesh: { kind: string; url: string } | null = null
  if (enableQuickMesh && !(await shouldSkipQuickMesh(supabase, orderId))) {
    try {
      quickMesh = await attachQuickMesh(
        orderId,
        uploaded.map((u) => ({ assetUrl: u.assetUrl, viewRole: u.viewRole || null }))
      )
    } catch (quickErr) {
      console.warn('[materialize] quick mesh failed', quickErr)
    }
  }

  return { uploaded, chosenImageId: chosenId, quickMesh, angleImages: autoAngleUploads }
}

export { shouldSkipQuickMesh }
