// LLM client wrapper (server-only). Add OPENAI_API_KEY in env to enable.
import OpenAI from 'openai'

export type ChatMessage = { role: 'system'|'user'|'assistant'|'tool'; content: string; name?: string; tool_call_id?: string }

export function getOpenAI(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not set')
  const baseURL = process.env.OPENAI_BASE_URL
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } as any : {}) })
}

// Default model: prefer user-specified via OPENAI_MODEL; else use the requested GPT‑5 variant.
export const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini-2025-08-07'
