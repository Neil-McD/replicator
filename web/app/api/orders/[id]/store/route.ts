import { NextResponse } from 'next/server'
import { randomUUID, createHash } from 'crypto'
import { Buffer } from 'buffer'
import { createAdminClient, parseSupabaseUrl, signedUrlOrDirect } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { ensureOrgForUser } from '@/lib/orgs'
import { parseDataUrl, toNumber } from '@/lib/storeUtils'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? 'artifacts'
const DEFAULT_PRICE_CENTS = Number(process.env.DEFAULT_STORE_PRICE_CENTS || 2800)
const DEFAULT_COST_CENTS = Number(process.env.DEFAULT_STORE_COST_CENTS || 1250)
const SIZE_TOLERANCE_MM = Math.max(0.1, Number(process.env.STORE_SIZE_TOLERANCE_MM || 0.75))

type StoreAuthContext = {
  isAdmin: boolean
  user: { id: string }
}

type StoreSupabaseClient = ReturnType<typeof createAdminClient>

function sanitizeText(value: any, fallback: string, max = 4000): string {
  const str = typeof value === 'string' ? value : ''
  const trimmed = str.trim()
  if (!trimmed) return fallback
  return trimmed.slice(0, max)
}

function pickSizedAsset(assets: any[], targetMm?: number | null, tolerance = SIZE_TOLERANCE_MM) {
  const hasTarget = typeof targetMm === 'number' && Number.isFinite(targetMm)
  const tol = Math.max(0.1, tolerance)
  for (let i = assets.length - 1; i >= 0; i--) {
    const asset = assets[i]
    if (!asset || String(asset.kind) !== 'repaired_sized_stl') continue
    if (!hasTarget) return asset
    const meta = asset.meta_json || {}
    const stored = Number(meta?.target_max_dim_mm ?? meta?.target_max_dim ?? meta?.target)
    if (!Number.isFinite(stored)) continue
    if (Math.abs(stored - (targetMm as number)) > tol) continue
    return asset
  }
  return null
}

async function copyOrDownloadAsset(
  supabase: ReturnType<typeof createAdminClient>,
  sourceUrl: string,
  destinationPath: string,
  existingSha?: string | null,
): Promise<{ storagePath: string; sha256?: string | null; sizeBytes?: number | null }> {
  const parsed = parseSupabaseUrl(sourceUrl)
  if (parsed && parsed.bucket === STORAGE_BUCKET) {
    const copyRes = await supabase.storage.from(STORAGE_BUCKET).copy(parsed.path, destinationPath)
    if (!copyRes.error) {
      return { storagePath: destinationPath, sha256: existingSha ?? null, sizeBytes: null }
    }
    console.warn('[orders/store] storage copy failed, falling back to download', copyRes.error?.message)
  }

  const signed = await signedUrlOrDirect(sourceUrl, 600)
  const response = await fetch(signed)
  if (!response.ok) {
    throw new Error(`failed_fetch_asset:${response.status}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const sha = createHash('sha256').update(buffer).digest('hex')
  const uploadRes = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(destinationPath, buffer, { contentType: 'application/sla', upsert: false })
  if (uploadRes.error) throw uploadRes.error
  return { storagePath: destinationPath, sha256: sha, sizeBytes: buffer.length }
}

export async function handleStoreRequest(options: {
  supabase: StoreSupabaseClient
  auth: StoreAuthContext
  orderId: string
  body: any
}) {
  const { supabase, auth, orderId, body } = options

  const requestedTarget = Number(body?.target_max_dim_mm)
  const tolerance = Number.isFinite(body?.target_tolerance_mm)
    ? Math.max(0.1, Math.min(10, Number(body.target_tolerance_mm)))
    : SIZE_TOLERANCE_MM
  const previewDataUrl = typeof body?.preview_data_url === 'string' ? body.preview_data_url : null
  const priceOverride = Number(body?.price_cents)
  const costOverride = Number(body?.cost_cents)
  const statusOverride = (body?.status || '').toString().trim() || 'draft'
  const visibilityOverride = (body?.visibility || '').toString().trim() || 'hidden'

  const { data: orderRow, error: orderErr } = await supabase
      .from('orders')
      .select('id,user_id,org_id,prompt_text,material,quote_json,meta_json,style,chosen_image_id,status')
      .eq('id', orderId)
      .maybeSingle()

  if (orderErr || !orderRow) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (!auth.isAdmin && orderRow.user_id && orderRow.user_id !== auth.user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const orgId = orderRow.org_id || (orderRow.user_id ? await ensureOrgForUser(supabase, orderRow.user_id) : null)
  if (!orgId) {
    return NextResponse.json({ error: 'org_missing' }, { status: 422 })
  }

  const { data: assets, error: assetsErr } = await supabase
      .from('assets')
      .select('id,kind,url,meta_json,created_at,sha256')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true })
      .limit(300)
  if (assetsErr) throw assetsErr

  const assetList = Array.isArray(assets) ? assets : []
  const sizedAsset = pickSizedAsset(assetList, requestedTarget, tolerance)
  const latestRepaired = (() => {
    for (let i = assetList.length - 1; i >= 0; i -= 1) {
      const row = assetList[i]
      if (row && row.kind === 'repaired_stl') return row
    }
    return null
  })()
  if (!sizedAsset) {
    if (latestRepaired) {
      const currentStatus = typeof orderRow.status === 'string' ? orderRow.status : null
      if (currentStatus !== 'exporting') {
        try {
          await supabase.from('orders').update({ status: 'exporting' }).eq('id', orderId)
          await supabase.from('order_events').insert({
            order_id: orderId,
            phase: 'export_requested',
            message: 'Catalog requested sized STL export',
          })
          await supabase.from('chat_messages').insert({
            order_id: orderId,
            role: 'assistant',
            type: 'text',
            content_json: { text: 'Sizing the mesh for your catalog listing — give me a moment.' },
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn('[orders/store] failed to enqueue export request', msg)
        }
      }
      return NextResponse.json({
        error: 'sized_asset_pending',
        status: 'pending_export',
        message: 'Queued a refreshed print-ready STL. Retry after it finishes exporting.',
      }, { status: 202 })
    }
    return NextResponse.json({
      error: 'sized_asset_missing',
      message: 'No repaired STL available yet. Generate or repair the mesh before publishing.',
    }, { status: 409 })
  }

  const sizedMeta = sizedAsset.meta_json || {}
  const targetStored = Number(sizedMeta?.target_max_dim_mm ?? sizedMeta?.target_max_dim ?? sizedMeta?.target)
  const effectiveTarget = Number.isFinite(targetStored) ? Number(targetStored) : (Number.isFinite(requestedTarget) ? Number(requestedTarget) : null)

  const quote = orderRow.quote_json || {}
  const priceCents = Number.isFinite(priceOverride) ? Math.max(0, Math.round(priceOverride)) : toNumber(quote?.price_cents, DEFAULT_PRICE_CENTS)
  const costCents = Number.isFinite(costOverride) ? Math.max(0, Math.round(costOverride)) : toNumber(quote?.cost_cents, DEFAULT_COST_CENTS)

  const prompt = typeof orderRow.prompt_text === 'string' ? orderRow.prompt_text : ''
  const defaultName = prompt ? prompt.slice(0, 160) : 'Untitled print'
  const name = sanitizeText(body?.name, defaultName, 160)
  const defaultDescription = `Generated via Replicator · ${orderRow.material || 'PLA'} · Longest side ${effectiveTarget ? `${Math.round(effectiveTarget)}mm` : 'custom'}.`
  const description = sanitizeText(body?.description, defaultDescription)

  const productInsert = await supabase
      .from('products')
      .insert({
        org_id: orgId,
        status: statusOverride,
        visibility: visibilityOverride,
      })
      .select('id')
      .single()
  if (productInsert.error || !productInsert.data?.id) throw productInsert.error ?? new Error('product_insert_failed')

    const productId = productInsert.data.id as string
    const versionNumber = 1

    const infoJson: Record<string, any> = {
      source: 'order',
      order_id: orderId,
      origin_asset_id: sizedAsset.id,
      target_max_dim_mm: effectiveTarget,
      quote,
    }
    if (sizedMeta?.orientation) infoJson.orientation = sizedMeta.orientation
    if (sizedMeta?.bbox_mm) infoJson.bbox_mm = sizedMeta.bbox_mm

    const versionInsert = await supabase
      .from('product_versions')
      .insert({
        product_id: productId,
        version: versionNumber,
        name,
        description,
        price_cents: priceCents,
        cost_cents: costCents,
        margin_cents: Math.max(priceCents - costCents, 0),
        info_json: infoJson,
        print_time_seconds: toNumber(quote?.minutes, 0) * 60,
        material_grams: Number(quote?.grams) || null,
      })
      .select('id')
      .single()
    if (versionInsert.error || !versionInsert.data?.id) throw versionInsert.error ?? new Error('version_insert_failed')

    const versionId = versionInsert.data.id as string

    const updateProduct = await supabase
      .from('products')
      .update({ current_version_id: versionId, status: statusOverride, visibility: visibilityOverride })
      .eq('id', productId)
    if (updateProduct.error) throw updateProduct.error

    const storagePath = `products/${productId}/v${versionNumber}/print-${randomUUID()}.stl`
    const copied = await copyOrDownloadAsset(supabase, sizedAsset.url as string, storagePath, sizedAsset.sha256 as string | null)

    const assetMeta = {
      source: 'order',
      order_id: orderId,
      origin_asset_id: sizedAsset.id,
      target_max_dim_mm: effectiveTarget,
      orientation: sizedMeta?.orientation ?? null,
      bbox_mm: sizedMeta?.bbox_mm ?? null,
      slice_check: sizedMeta?.slice_check ?? null,
    }
    const sizeBytesMeta = Number(sizedMeta?.size_bytes)
    const resolvedSizeBytes = copied.sizeBytes ?? (Number.isFinite(sizeBytesMeta) ? sizeBytesMeta : null)

    const productAssetInsert = await supabase
      .from('product_assets')
      .insert({
        product_id: productId,
        version: versionNumber,
        kind: 'repaired_stl',
        storage_path: copied.storagePath,
        sha256: copied.sha256 ?? (sizedAsset.sha256 as string | null) ?? null,
        size_bytes: resolvedSizeBytes,
        meta_json: assetMeta,
      })
    if (productAssetInsert.error) throw productAssetInsert.error

    if (previewDataUrl) {
      const preview = parseDataUrl(previewDataUrl)
      if (preview) {
        const previewPath = `products/${productId}/v${versionNumber}/preview-${randomUUID()}.${preview.ext}`
        const previewUpload = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(previewPath, preview.buffer, { contentType: preview.mime, upsert: false })
        if (!previewUpload.error) {
          const previewMeta = {
            source: 'order',
            order_id: orderId,
            origin: 'viewer',
            target_max_dim_mm: effectiveTarget,
          }
          await supabase.from('product_assets').insert({
            product_id: productId,
            version: versionNumber,
            kind: 'thumbnail',
            storage_path: previewPath,
            meta_json: previewMeta,
            size_bytes: preview.buffer.length,
          })
        } else {
          console.warn('[orders/store] preview upload failed', previewUpload.error.message)
        }
      }
    }

  try {
    const existingMeta = (orderRow.meta_json as Record<string, any>) || {}
    const nextMeta = {
      ...existingMeta,
      store: {
        ...(existingMeta.store || {}),
        product_id: productId,
        version: versionNumber,
        target_max_dim_mm: effectiveTarget,
        created_at: new Date().toISOString(),
      },
    }
    await supabase.from('orders').update({ meta_json: nextMeta }).eq('id', orderId)
  } catch (err) {
    console.warn('[orders/store] failed to update order meta', (err as Error)?.message)
  }

  try {
    await supabase.from('order_events').insert({
      order_id: orderId,
      phase: 'store',
      message: 'Added to catalog',
      meta_json: { product_id: productId, version: versionNumber },
    })
  } catch (err) {
    console.warn('[orders/store] failed to record order event', (err as Error)?.message)
  }

  return NextResponse.json({ productId, version: versionNumber })
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const orderId = params.id
  try {
    const auth = await requireAuthContext(req)
    const supabase = createAdminClient()
    const body = await req.json().catch(() => ({}))
    return await handleStoreRequest({ supabase, auth, orderId, body })
  } catch (error: any) {
    console.error('[orders/store] error', error?.message)
    return NextResponse.json({ error: error?.message || 'failed' }, { status: 500 })
  }
}
