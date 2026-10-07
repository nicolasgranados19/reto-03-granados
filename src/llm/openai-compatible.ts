import OpenAI from "openai"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { DefinicionHerramienta, LlmAdapter, Mensaje, RespuestaLlm } from "./adapter"

type ClienteChat = { chat: { completions: { create: (cuerpo: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming, opciones?: { signal?: AbortSignal }) => Promise<OpenAI.Chat.ChatCompletion> } } }
type Opciones = { cliente?: ClienteChat; dormir?: (ms: number) => Promise<void>; logPath?: string }

const REINTENTOS_MAX = 4
const BACKOFF_MS = [5000, 15000, 30000, 30000]
const ESPERA_MAX_MS = 60000

function cabecera(e: unknown, nombre: string): string | null {
  const h = (e as { headers?: unknown }).headers
  if (!h) return null
  if (typeof (h as { get?: unknown }).get === "function") return (h as { get: (k: string) => string | null }).get(nombre)
  const v = (h as Record<string, unknown>)[nombre]
  return typeof v === "string" ? v : null
}

/** Espera ante un 429: retry-after-ms, retry-after (s), "try again in" del mensaje o backoff 5/15/30 s. */
export function esperaPara429(e: unknown, reintento: number): number {
  const ms = Number(cabecera(e, "retry-after-ms"))
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, ESPERA_MAX_MS)
  const seg = Number(cabecera(e, "retry-after"))
  if (Number.isFinite(seg) && seg > 0) return Math.min(seg * 1000, ESPERA_MAX_MS)
  return BACKOFF_MS[Math.min(reintento, BACKOFF_MS.length - 1)] ?? 30000
}

export class OpenAICompatible implements LlmAdapter {
  readonly proveedor: string
  readonly modelo: string
  /** Total de reintentos por 429 desde que arrancó el proceso (el loop lo usa para medir). */
  reintentos = 0
  private cliente: ClienteChat
  private timeoutMs: number
  private dormir: (ms: number) => Promise<void>
  private logPath: string

  constructor(env: Record<string, string | undefined> = process.env, opciones: Opciones = {}) {
    this.proveedor = env.LLM_PROVIDER || "openai-compatible"
    this.modelo = env.LLM_MODEL || ""
    this.timeoutMs = Number(env.LLM_TIMEOUT_MS) || 30000
    this.cliente =
      opciones.cliente ??
      (new OpenAI({ baseURL: env.LLM_BASE_URL || undefined, apiKey: env.LLM_API_KEY || "sin-clave", maxRetries: 0 }) as unknown as ClienteChat)
    this.dormir = opciones.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.logPath = opciones.logPath ?? join(import.meta.dir, "..", "..", "out", "log.jsonl")
  }

  private registrarReintento(n: number, esperaMs: number) {
    try {
      mkdirSync(join(this.logPath, ".."), { recursive: true })
      const resumen = `429 del proveedor: reintento ${n}/${REINTENTOS_MAX} en ${esperaMs} ms`
      appendFileSync(this.logPath, JSON.stringify({ ts: new Date().toISOString(), sessionId: "llm", herramienta: "llm_reintento", ok: false, resumen }) + "\n")
    } catch {
      /* el log nunca rompe la llamada */
    }
  }

  /** Reintenta hasta 4 veces ante 429. El timeout aplica a cada intento, no al total. */
  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLlm> {
    for (let intento = 0; ; intento++) {
      try {
        return await this.enviarUna(mensajes, herramientas)
      } catch (e) {
        const original = (e as { original429?: unknown }).original429
        if (original === undefined || intento >= REINTENTOS_MAX) throw e
        const espera = esperaPara429(original, intento)
        this.reintentos++
        this.registrarReintento(intento + 1, espera)
        await this.dormir(espera)
      }
    }
  }

  private async enviarUna(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLlm> {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      const msgs = mensajes.map((m): OpenAI.Chat.ChatCompletionMessageParam => {
        if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content }
        if (m.role === "assistant") {
          return {
            role: "assistant",
            content: m.content || null,
            ...(m.toolCalls?.length
              ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.nombre, arguments: c.argumentos } })) }
              : {}),
          }
        }
        return { role: m.role, content: m.content }
      })
      const r = await this.cliente.chat.completions.create(
        {
          model: this.modelo,
          messages: msgs,
          ...(herramientas.length
            ? { tools: herramientas.map((h) => ({ type: "function" as const, function: { name: h.nombre, description: h.descripcion, parameters: h.parametros } })) }
            : {}),
        },
        { signal: ac.signal },
      )
      const msg = r.choices[0]?.message
      const llamadas = (msg?.tool_calls ?? []).flatMap((c) =>
        c.type === "function" ? [{ id: c.id, nombre: c.function.name, argumentos: c.function.arguments || "{}" }] : [],
      )
      return {
        texto: msg?.content ?? "",
        llamadas,
        tokens: { entrada: r.usage?.prompt_tokens ?? 0, salida: r.usage?.completion_tokens ?? 0 },
      }
    } catch (e) {
      if (ac.signal.aborted) throw new Error(`El modelo no respondió en ${this.timeoutMs} ms (timeout).`)
      const status = (e as { status?: number }).status
      if (status === 429) {
        throw Object.assign(new Error("El proveedor del modelo rechazó la solicitud por límite de cuota (429). Intenta de nuevo en un momento o cambia LLM_MODEL."), { original429: e })
      }
      if (status === 401 || status === 403) throw new Error(`El proveedor del modelo rechazó las credenciales (${status}).`)
      throw new Error(`Error del proveedor del modelo${status ? ` (${status})` : ""}: ${e instanceof Error ? e.message.slice(0, 200) : "desconocido"}`)
    } finally {
      clearTimeout(t)
    }
  }
}
