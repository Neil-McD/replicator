import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { ensureOrgForUser } from '@/lib/orgs'

type UpdatePayload = {
  name?: string
  description?: string
  priceCents?: number
  costCents?: number
  visibility?: 'visible' | 'hidden' | 'archived'
  status?: string
}

function toCents(value: any, fallback: number) {
  if (value === undefined || value === null) return fallback
  const num = Number(value)
  return Number.isFinite(num) ? Math.round(num) : fallback
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = await req.json().catch(() => ({})) as { user_id?: string; data?: UpdatePayload }
    const userId = body.user_id
    const updates = body.data ?? {}
    if (!userId) {
      return NextResponse.json({ error: 'user_id required' }, { status: 400 })
    }

    const productId = params.id
    const supabase = createAdminClient()
    const orgId = await ensureOrgForUser(supabase, userId)

    const { data: product, error: productErr } = await supabase
      .from('products')
      .select('*')
      .eq('id', productId)
      .is('deleted_at', null)
      .single()
    if (productErr) throw productErr
    if (!product || product.org_id !== orgId) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }

    const { data: latestVersion, error: versionErr } = await supabase
      .from('product_versions')
      .select('*')
      .eq('product_id', productId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (versionErr) throw versionErr

    const baseName = updates.name ?? latestVersion?.name ?? 'Untitled product'
    const baseDescription = updates.description ?? latestVersion?.description ?? ''
    const basePrice = toCents(updates.priceCents, Number(latestVersion?.price_cents ?? 0))
    const baseCost = toCents(updates.costCents, Number(latestVersion?.cost_cents ?? 0))
    const margin = Math.max(basePrice - baseCost, 0)
    const nextVersionNumber = Number(latestVersion?.version ?? 0) + 1

    const { data: insertedVersion, error: insertVersionErr } = await supabase
      .from('product_versions')
      .insert({
        product_id: productId,
        version: nextVersionNumber,
        name: baseName,
        description: baseDescription,
        price_cents: basePrice,
        cost_cents: baseCost,
        margin_cents: margin,
        info_json: latestVersion?.info_json ?? {},
      })
      .select('id')
      .single()
    if (insertVersionErr) throw insertVersionErr
    const newVersionId = insertedVersion.id as string

    if (latestVersion) {
      const { data: priorAssets, error: priorAssetErr } = await supabase
        .from('product_assets')
        .select('*')
        .eq('product_id', productId)
        .eq('version', latestVersion.version)
      if (priorAssetErr) throw priorAssetErr
      if ((priorAssets ?? []).length > 0) {
        const copyRows = (priorAssets ?? []).map((asset) => ({
          product_id: asset.product_id,
          version: nextVersionNumber,
          kind: asset.kind,
          storage_path: asset.storage_path,
          sha256: asset.sha256,
          size_bytes: asset.size_bytes,
          meta_json: asset.meta_json,
        }))
        const { error: copyErr } = await supabase.from('product_assets').insert(copyRows)
        if (copyErr) throw copyErr
      }
    }

    const visibility = updates.visibility ?? product.visibility
    const status = updates.status ?? product.status

    const { error: updateProductErr } = await supabase
      .from('products')
      .update({
        current_version_id: newVersionId,
        visibility,
        status,
      })
      .eq('id', productId)
    if (updateProductErr) throw updateProductErr

    return NextResponse.json({ ok: true, version_id: newVersionId })
  } catch (error: any) {
    console.error('[api/store/products PATCH] error', error?.message)
    return NextResponse.json({ error: error?.message ?? 'failed' }, { status: 500 })
  }
}

