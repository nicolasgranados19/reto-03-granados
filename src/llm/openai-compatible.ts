import OpenAI from "openai"
import type { DefinicionHerramienta, LlmAdapter, Mensaje, RespuestaLlm } from "./adapter"

export class OpenAICompatible implements LlmAdapter {
  readonly proveedor: string
  readonly modelo: string
  private cliente: OpenAI
  private timeoutMs: number

  constructor(env: Record<string, string | undefined> = process.env) {
    this.proveedor = env.LLM_PROVIDER || "openai-compatible"
    this.modelo = env.LLM_MODEL || ""
    this.timeoutMs = Number(env.LLM_TIMEOUT_MS) || 30000
    this.cliente = new OpenAI({ baseURL: env.LLM_BASE_URL || undefined, apiKey: env.LLM_API_KEY || "sin-clave", maxRetries: 0 })
  }

  /** Reintenta ante 429 esperando el tiempo que indica el proveedor (máx. 25 s por espera, 3 intentos). */
  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLlm> {
    for (let intento = 1; ; intento++) {
      try {
        return await this.enviarUna(mensajes, herramientas)
      } catch (e) {
        const espera = (e as { esperaMs?: number }).esperaMs
        if (espera === undefined || intento >= 3 || espera > 25000) throw e
        await new Promise((r) => setTimeout(r, espera + 500))
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
        const h = (e as { headers?: { get?: (k: string) => string | null } }).headers?.get?.("retry-after")
        const m = e instanceof Error ? /try again in ([\d.]+)(ms|s)/i.exec(e.message) : null
        const espera = h ? Number(h) * 1000 : m ? Number(m[1]) * (m[2] === "ms" ? 1 : 1000) : 5000
        throw Object.assign(new Error("El proveedor del modelo rechazó la solicitud por límite de cuota (429). Intenta de nuevo en un momento o cambia LLM_MODEL."), { esperaMs: espera })
      }
      if (status === 401 || status === 403) throw new Error(`El proveedor del modelo rechazó las credenciales (${status}).`)
      throw new Error(`Error del proveedor del modelo${status ? ` (${status})` : ""}: ${e instanceof Error ? e.message.slice(0, 200) : "desconocido"}`)
    } finally {
      clearTimeout(t)
    }
  }
}
