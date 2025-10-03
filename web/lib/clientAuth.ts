"use client"
import { supabaseBrowser } from './supabaseClient'

let currentToken: string | null = null
let pendingSession: Promise<string | null> | null = null
let subscriptionInitialized = false
let authSubscription: { unsubscribe: () => void } | null = null
const listeners = new Set<(token: string | null) => void>()

function notify(token: string | null) {
  for (const listener of listeners) {
    try { listener(token) } catch (err) { console.warn('[clientAuth] listener error', err) }
  }
}

function ensureSubscription() {
  if (subscriptionInitialized) return
  const { data } = supabaseBrowser.auth.onAuthStateChange((_event, session) => {
    currentToken = session?.access_token || null
    notify(currentToken)
  })
  authSubscription = data?.subscription ?? null
  subscriptionInitialized = true
}

function maybeTearDownSubscription() {
  if (!subscriptionInitialized) return
  if (listeners.size > 0) return
  authSubscription?.unsubscribe?.()
  authSubscription = null
  subscriptionInitialized = false
}

export function onAccessTokenChange(listener: (token: string | null) => void) {
  ensureSubscription()
  listeners.add(listener)
  listener(currentToken)
  return () => {
    listeners.delete(listener)
    maybeTearDownSubscription()
  }
}

async function fetchSession(): Promise<string | null> {
  ensureSubscription()
  if (!pendingSession) {
    pendingSession = supabaseBrowser.auth
      .getSession()
      .then(({ data }) => {
        currentToken = data?.session?.access_token || null
        notify(currentToken)
        return currentToken
      })
      .catch((err) => {
        console.warn('[clientAuth] getSession failed', err)
        currentToken = null
        notify(currentToken)
        return null
      })
      .finally(() => {
        pendingSession = null
      })
  }
  return pendingSession
}

export async function getAccessToken(forceRefresh = false): Promise<string | null> {
  if (forceRefresh) {
    currentToken = null
    pendingSession = null
  }
  if (currentToken && !forceRefresh) return currentToken
  return (await fetchSession()) ?? currentToken
}

export async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}, opts: { forceRefresh?: boolean } = {}) {
  let token = await getAccessToken(opts.forceRefresh || false)
  if (!token) throw new Error('not_authenticated')
  const buildHeaders = (authToken: string) => {
    const headers = new Headers(init.headers || {})
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${authToken}`)
    return headers
  }
  let response = await fetch(input, { ...init, headers: buildHeaders(token) })
  if (response.status === 401 && !opts.forceRefresh) {
    token = await getAccessToken(true)
    if (!token) throw new Error('not_authenticated')
    response = await fetch(input, { ...init, headers: buildHeaders(token) })
  }
  return response
}

export function clearCachedAccessToken() {
  currentToken = null
  pendingSession = null
  notify(null)
}
