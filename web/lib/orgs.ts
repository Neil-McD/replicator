import { randomUUID } from 'crypto'
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'

export type AdminClient = SupabaseClient<any, 'public', any>

function normalizeMessage(error: PostgrestError | null | undefined): string {
  if (!error) return ''
  return `${error.message ?? ''}`.toLowerCase()
}

function isMissingTableError(error: PostgrestError | null | undefined, table: string): boolean {
  if (!error) return false
  const message = normalizeMessage(error)
  if (!message) return false
  const needle = table.toLowerCase()
  return (
    message.includes(`table '${needle}`)
    || message.includes(`table 'public.${needle}`)
    || message.includes(`relation "${needle}`)
    || message.includes(`relation "public.${needle}`)
  )
}

function isMissingColumnError(error: PostgrestError | null | undefined, table: string, column: string): boolean {
  if (!error) return false
  const message = normalizeMessage(error)
  if (!message) return false
  const col = column.toLowerCase()
  const tbl = table.toLowerCase()
  return (
    message.includes(`column '${col}`)
    || message.includes(`column "${col}`)
    || message.includes(`column '${tbl}.${col}`)
    || message.includes(`column "${tbl}.${col}`)
    || message.includes(`column 'public.${tbl}.${col}`)
    || message.includes(`column "public.${tbl}.${col}`)
  )
}

export { isMissingTableError, isMissingColumnError }

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace'
}

export async function ensureOrgForUser(client: AdminClient, userId: string): Promise<string> {
  const existing = await client
    .from('org_members')
    .select('org_id')
    .eq('user_id', userId)
    .is('removed_at', null)
    .limit(1)
    .maybeSingle()

  if (existing.error) {
    if (isMissingTableError(existing.error, 'org_members')) {
      console.warn('[ensureOrgForUser] org_members table missing; using fallback org id')
      return userId
    }
    throw existing.error
  }

  if (existing?.data?.org_id) {
    return existing.data.org_id
  }

  const orgName = 'Personal workspace'
  const slugCandidate = slugifyName(orgName)
  const orgInsert = await client
    .from('orgs')
    .insert({
      owner_user_id: userId,
      name: orgName,
      slug: `${slugCandidate}-${randomUUID().slice(0, 8)}`,
    })
    .select('id')
    .single()

  if (orgInsert.error || !orgInsert.data?.id) {
    if (isMissingTableError(orgInsert.error, 'orgs')) {
      console.warn('[ensureOrgForUser] orgs table missing; returning fallback org id')
      return userId
    }
    throw orgInsert.error ?? new Error('failed to create org')
  }

  const orgId = orgInsert.data.id as string

  const memberInsert = await client
    .from('org_members')
    .insert({ org_id: orgId, user_id: userId, role: 'owner' })
  if (memberInsert.error) {
    if (isMissingTableError(memberInsert.error, 'org_members')) {
      console.warn('[ensureOrgForUser] org_members table missing on insert; ignoring in demo mode')
      return orgId
    }
    throw memberInsert.error
  }

  return orgId
}

export async function ensureDemoChannels(client: AdminClient, orgId: string) {
  const { data, error } = await client
    .from('channel_accounts')
    .select('id, kind')
    .eq('org_id', orgId)

  if (error) {
    if (isMissingTableError(error, 'channel_accounts')) {
      console.warn('[ensureDemoChannels] channel_accounts table missing; skipping demo channels')
      return
    }
    throw error
  }

  const kinds = new Set((data ?? []).map((row) => row.kind))
  const inserts: Array<Record<string, any>> = []
  if (!kinds.has('shopify')) {
    inserts.push({ org_id: orgId, kind: 'shopify', status: 'connected', display_name: 'Shopify' })
  }
  if (!kinds.has('etsy')) {
    inserts.push({ org_id: orgId, kind: 'etsy', status: 'pending', display_name: 'Etsy' })
  }
  if (!kinds.has('tiktok')) {
    inserts.push({ org_id: orgId, kind: 'tiktok', status: 'disconnected', display_name: 'TikTok' })
  }
  if (inserts.length === 0) return
  const { error: insertError } = await client.from('channel_accounts').insert(inserts)
  if (insertError) {
    if (isMissingTableError(insertError, 'channel_accounts')) {
      console.warn('[ensureDemoChannels] channel_accounts table missing on insert; skipping demo channels')
      return
    }
    throw insertError
  }
}
