import { NextResponse } from 'next/server'
import { createHash, randomUUID } from 'crypto'
import { Buffer } from 'buffer'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { ensureDemoChannels, ensureOrgForUser } from '@/lib/orgs'
import {
  toNumber,
  extensionFromFileName,
  assetKindFromExtension,
  contentTypeFromExtension,
  parseDataUrl,
} from '@/lib/storeUtils'

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? 'artifacts'

async function hydrateProduct(supabase: ReturnType<typeof createAdminClient>, product: any) {
  const versionId = product.current_version_id as string | null
  let version: any | null = null
  if (versionId) {
    const { data, error } = await supabase
      .from('product_versions')
      .select('*')
      .eq('id', versionId)
      .maybeSingle()
    if (error) throw error
    version = data
  }
  if (!version) {
    const { data, error } = await supabase
      .from('product_versions')
      .select('*')
      .eq('product_id', product.id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    version = data
  }

  const versionNumber = version?.version ?? 1

  const { data: assets, error: assetsErr } = await supabase
    .from('product_assets')
    .select('*')
    .eq('product_id', product.id)
    .eq('version', versionNumber)
  if (assetsErr) throw assetsErr

  const { data: metrics } = await supabase
    .from('product_metrics')
    .select('*')
    .eq('product_id', product.id)
    .maybeSingle()

  const { data: channelStates, error: channelErr } = await supabase
    .from('product_channel_state')
    .select('id, status, channel_account_id, listing_id, last_synced_at')
    .eq('product_id', product.id)
  if (channelErr) throw channelErr

  const channelAccountIds = (channelStates ?? []).map((state) => state.channel_account_id).filter(Boolean)
  const accountMap = new Map<string, any>()
  if (channelAccountIds.length > 0) {
    const { data: channelAccounts, error: accountsErr } = await supabase
      .from('channel_accounts')
      .select('id, kind, display_name, status')
      .in('id', channelAccountIds)
    if (accountsErr) throw accountsErr
    for (const account of channelAccounts ?? []) {
      accountMap.set(account.id, account)
    }
  }

  const concepts = (assets ?? [])
    .filter((a) => a.kind === 'concept_image' || a.kind === 'thumbnail')
    .map((a) => ({
      url: a.meta_json?.url || a.storage_path,
      kind: a.kind,
    }))

  const priceCents = toNumber(version?.price_cents, 0)
  const costCents = toNumber(version?.cost_cents, 0)
  const marginCents = Number.isFinite(Number(version?.margin_cents))
    ? Number(version.margin_cents)
    : Math.max(priceCents - costCents, 0)

  return {
    id: product.id,
    status: product.status,
    visibility: product.visibility,
    updatedAt: product.updated_at,
    createdAt: product.created_at,
    version: versionNumber,
    versionId: version?.id ?? null,
    name: version?.name ?? 'Untitled product',
    description: version?.description ?? '',
    priceCents,
    costCents,
    marginCents,
    conceptImages: concepts,
    channels: (channelStates ?? []).map((state) => {
      const account = accountMap.get(state.channel_account_id)
      return {
        id: state.id,
        status: state.status,
        listingId: state.listing_id,
        lastSyncedAt: state.last_synced_at,
        account: account
          ? {
              id: account.id,
              kind: account.kind,
              displayName: account.display_name,
              status: account.status,
            }
          : null,
      }
    }),
    metrics: metrics ?? null,
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const userId = url.searchParams.get('user_id')
    if (!userId) return NextResponse.json({ error: 'user_id required' }, { status: 400 })

    const supabase = createAdminClient()
    const orgId = await ensureOrgForUser(supabase, userId)
    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })

    if (error) throw error

    const hydrated = await Promise.all((products ?? []).map((product) => hydrateProduct(supabase, product)))
    return NextResponse.json({ products: hydrated })
  } catch (error: any) {
    console.error('[api/store/products GET] error', error?.message)
    return NextResponse.json({ error: error?.message ?? 'failed' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData()
    const userId = formData.get('user_id')?.toString()
    if (!userId) return NextResponse.json({ error: 'user_id required' }, { status: 400 })

    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'file required' }, { status: 400 })
    }

    const supabase = createAdminClient()
    const orgId = await ensureOrgForUser(supabase, userId)
    await ensureDemoChannels(supabase, orgId)

    const name = (formData.get('name')?.toString() || 'Untitled product').slice(0, 160)
    const description = (formData.get('description')?.toString() || '').slice(0, 4000)
    const priceCents = toNumber(formData.get('priceCents'), 0)
    const costCents = toNumber(formData.get('costCents'), 0)
    const status = formData.get('status')?.toString() || 'draft'
    const visibility = formData.get('visibility')?.toString() || 'hidden'

    const { data: productInsert, error: productErr } = await supabase
      .from('products')
      .insert({
        org_id: orgId,
        status,
        visibility,
      })
      .select('id, created_at, updated_at, current_version_id')
      .single()
    if (productErr) throw productErr

    const productId = productInsert.id as string
    const versionNumber = 1

    const { data: versionInsert, error: versionErr } = await supabase
      .from('product_versions')
      .insert({
        product_id: productId,
        version: versionNumber,
        name,
        description,
        price_cents: priceCents,
        cost_cents: costCents,
        margin_cents: Math.max(priceCents - costCents, 0),
        info_json: {
          source: 'upload',
          original_filename: file.name,
        },
      })
      .select('id')
      .single()
    if (versionErr) throw versionErr

    const versionId = versionInsert.id as string

    const { error: updateProductErr } = await supabase
      .from('products')
      .update({ current_version_id: versionId, status, visibility })
      .eq('id', productId)
    if (updateProductErr) throw updateProductErr

    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const fileExt = extensionFromFileName(file.name) || 'stl'
    const storagePath = `products/${productId}/v${versionNumber}/${randomUUID()}.${fileExt}`
    const contentType = contentTypeFromExtension(fileExt, file.type)

    const { error: uploadErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, buffer, { contentType, upsert: false })
    if (uploadErr) throw uploadErr

    const { error: assetErr } = await supabase.from('product_assets').insert({
      product_id: productId,
      version: versionNumber,
      kind: assetKindFromExtension(fileExt),
      storage_path: storagePath,
      sha256,
      size_bytes: buffer.length,
      meta_json: {
        original_filename: file.name,
        mime_type: contentType,
        source: 'upload',
      },
    })
    if (assetErr) throw assetErr

    const previewDataUrl = formData.get('previewDataUrl')
    const preview = parseDataUrl(typeof previewDataUrl === 'string' ? previewDataUrl : null)
    if (preview) {
      const previewPath = `products/${productId}/v${versionNumber}/thumbnail-${randomUUID()}.${preview.ext}`
      const { error: previewUploadErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(previewPath, preview.buffer, {
          contentType: preview.mime,
          upsert: false,
        })
      if (!previewUploadErr) {
        const previewMeta = {
          url: `supabase://${STORAGE_BUCKET}/${previewPath}`,
          source: 'upload',
        }
        const { error: previewAssetErr } = await supabase.from('product_assets').insert({
          product_id: productId,
          version: versionNumber,
          kind: 'thumbnail',
          storage_path: previewPath,
          meta_json: previewMeta,
          size_bytes: preview.buffer.length,
        })
        if (previewAssetErr) {
          console.warn('[api/store/products] failed to persist preview asset', previewAssetErr.message)
        }
      } else {
        console.warn('[api/store/products] failed to upload preview image', previewUploadErr.message)
      }
    }

    const { data: finalProduct, error: finalProductErr } = await supabase
      .from('products')
      .select('*')
      .eq('id', productId)
      .maybeSingle()
    if (finalProductErr) throw finalProductErr
    const payload = await hydrateProduct(supabase, finalProduct ?? {
      ...productInsert,
      id: productId,
      status,
      visibility,
      current_version_id: versionId,
    })
    return NextResponse.json({ product: payload })
  } catch (error: any) {
    console.error('[api/store/products POST] error', error?.message)
    return NextResponse.json({ error: error?.message ?? 'failed' }, { status: 500 })
  }
}
