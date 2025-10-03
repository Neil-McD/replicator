#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function loadEnvFile(relativePath) {
  const full = path.resolve(__dirname, '..', relativePath)
  if (!fs.existsSync(full)) return
  const raw = fs.readFileSync(full, 'utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (!key) continue
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}

loadEnvFile('.env')
loadEnvFile('.env.local')

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'artifacts'

if (!url || !serviceKey) {
  console.error('Missing Supabase environment variables (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).')
  process.exit(1)
}

const client = createClient(url, serviceKey, { auth: { persistSession: false } })

const TABLES = [
  { table: 'order_events', column: 'order_id' },
  { table: 'generation_tasks', column: 'order_id' },
  { table: 'chat_messages', column: 'order_id' },
  { table: 'assets', column: 'order_id' },
  { table: 'images', column: 'order_id' },
  { table: 'payments', column: 'order_id' },
  { table: 'orders', column: 'id' },
  { table: 'product_assets', column: 'product_id' },
  { table: 'product_versions', column: 'product_id' },
  { table: 'product_tag_links', column: 'product_id' },
  { table: 'product_tags', column: 'id' },
  { table: 'product_metrics', column: 'product_id' },
  { table: 'products', column: 'id' },
  { table: 'org_members', column: 'org_id' },
  { table: 'org_invites', column: 'org_id' },
  { table: 'orgs', column: 'id' },
  { table: 'profiles', column: 'user_id' },
]

const SENTINEL_UUID = '00000000-0000-0000-0000-000000000000'

async function purgeTable({ table, column }) {
  const query = client.from(table).delete({ count: 'exact' })
  if (column === 'id') {
    query.neq(column, SENTINEL_UUID)
  } else {
    query.or(`${column}.neq.${SENTINEL_UUID},${column}.is.null`)
  }
  const { error, count } = await query
  if (error) {
    const msg = error.message || ''
    if (msg.includes('schema cache') || msg.includes('does not exist')) {
      console.log(`Skipping ${table} (table not found)`)
      return
    }
    throw new Error(`Failed to purge ${table}: ${error.message}`)
  }
  console.log(`Cleared ${table}${typeof count === 'number' ? ` (${count} rows)` : ''}`)
}

async function purgeTables() {
  for (const def of TABLES) {
    await purgeTable(def)
  }
}

async function listRecursive(bucketName, prefix = '') {
  const files = []
  const folders = []
  const { data, error } = await client.storage.from(bucketName).list(prefix, { limit: 1000 })
  if (error) throw new Error(`Failed to list storage at "${prefix}": ${error.message}`)
  for (const entry of data || []) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.id) {
      files.push(entryPath)
    } else {
      folders.push(entryPath)
    }
  }
  for (const folder of folders) {
    const nested = await listRecursive(bucketName, folder)
    files.push(...nested)
  }
  return files
}

async function clearBucket(bucketName) {
  try {
    const files = await listRecursive(bucketName)
    if (!files.length) {
      console.log(`Storage bucket "${bucketName}" already empty`)
      return
    }
    const chunkSize = 100
    for (let i = 0; i < files.length; i += chunkSize) {
      const chunk = files.slice(i, i + chunkSize)
      const { error } = await client.storage.from(bucketName).remove(chunk)
      if (error) throw new Error(`Failed to remove storage objects: ${error.message}`)
    }
    console.log(`Removed ${files.length} object(s) from storage bucket "${bucketName}"`)
  } catch (err) {
    if (String(err?.message || '').includes('Storage bucket does not exist')) {
      console.log(`Storage bucket "${bucketName}" not found; skipping`)
      return
    }
    throw err
  }
}

async function main() {
  try {
    await purgeTables()
    await clearBucket(bucket)
    console.log('Supabase reset completed.')
  } catch (err) {
    console.error(err)
    process.exitCode = 1
  }
}

await main()
