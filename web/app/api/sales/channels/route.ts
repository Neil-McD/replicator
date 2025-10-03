import { NextResponse } from 'next/server'
import { requireAuthContext } from '@/lib/apiAuth'

type ChannelStatus = 'connected' | 'syncing' | 'error' | 'disconnected'

type ChannelPayload = {
  id: string
  name: string
  kind: string
  status: ChannelStatus
  lastSync: string
  totalSalesCents: number
  pendingOrders: number
  avatar: string
  link?: string
}

const CHANNELS: ChannelPayload[] = [
  {
    id: 'shopify-1',
    name: 'Shopify Storefront',
    kind: 'shopify',
    status: 'connected',
    lastSync: '3 min ago',
    totalSalesCents: 164000,
    pendingOrders: 6,
    avatar: '🛒',
  },
  {
    id: 'etsy-1',
    name: 'Etsy Marketplace',
    kind: 'etsy',
    status: 'syncing',
    lastSync: '12 min ago',
    totalSalesCents: 98000,
    pendingOrders: 3,
    avatar: '🧶',
  },
  {
    id: 'tiktok-1',
    name: 'TikTok Shop',
    kind: 'tiktok',
    status: 'connected',
    lastSync: '6 min ago',
    totalSalesCents: 72000,
    pendingOrders: 8,
    avatar: '🎵',
  },
  {
    id: 'custom-1',
    name: 'Custom Webhook',
    kind: 'webhook',
    status: 'error',
    lastSync: '28 min ago',
    totalSalesCents: 12400,
    pendingOrders: 1,
    avatar: '🧩',
  },
]

export async function GET(req: Request) {
  let auth
  try {
    auth = await requireAuthContext(req)
  } catch (error: any) {
    const status = Number(error?.statusCode) || 401
    return NextResponse.json({ error: 'not_authenticated' }, { status })
  }
  if (!auth.isAdmin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  // TODO: fetch from Supabase (channel_accounts joined with metrics)
  return NextResponse.json({ channels: CHANNELS })
}
