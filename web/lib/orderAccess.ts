import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuthContext } from './apiAuth'

export type AdminClient = SupabaseClient<any, 'public', any>

export async function requireOrderAccess<T extends string = 'id,user_id'>(
  client: AdminClient,
  orderId: string,
  auth: AuthContext,
  columns?: T
): Promise<any> {
  const selectColumns = columns || ('id,user_id' as T)
  const { data, error } = await client
    .from('orders')
    .select(selectColumns)
    .eq('id', orderId)
    .single()
  if (error || !data) {
    const err: any = new Error('not_found')
    err.statusCode = 404
    throw err
  }
  const ownerId = (data as any).user_id
  if (!auth.isAdmin && ownerId && ownerId !== auth.user.id) {
    const err: any = new Error('forbidden')
    err.statusCode = 403
    throw err
  }
  return data
}

export function handleOrderAccessError(error: any) {
  const status = Number(error?.statusCode) || 500
  if (status === 404) return { status, body: { error: 'not_found' } }
  if (status === 403) return { status, body: { error: 'forbidden' } }
  return { status, body: { error: error?.message || 'failed' } }
}
