import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { LlmAdapter, Mensaje } from "../llm/adapter"
import { definiciones, ejecutar } from "./registry"

export const RAIZ = join(import.meta.dir, "..", "..")
const CONFIRMA = /\b(s[ií]|confirmo|confirmado|procede|adelante|env[ií]a|crea|registra|de acuerdo|ok)\b/i

export type ToolCallInfo = { nombre: string; argumentos: unknown; ok: boolean; resumen: string; resultado?: unknown }
export type Session = {
  id: string
  messages: Mensaje[]
  toolCalls: ToolCallInfo[]
  tokens: number
  creada: string
  needsConfirmation: boolean
}
export type TurnoResultado = { reply: string; toolCalls: ToolCallInfo[]; needsConfirmation: boolean }

const sesiones = new Map<string, Session>()
const outDir = () => join(RAIZ, "out")
const num = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d)
const archivoSesion = (id: string) => join(outDir(), "sessions", `${id.replace(/[^\w-]/g, "_")}.json`)

export function construirSystemPrompt(dir = RAIZ): string {
  const partes = [readFileSync(join(dir, "agent", "prompt.md"), "utf8")]
  const kd = join(dir, "src", "knowledge")
  if (existsSync(kd)) {
    for (const f of readdirSync(kd).filter((x) => x.endsWith(".md")).sort()) partes.push(readFileSync(join(kd, f), "utf8"))
  }
  return partes.join("\n\n---\n\n")
}
const SYSTEM = construirSystemPrompt()

export function obtenerSesion(id: string): Session | undefined {
  const m = sesiones.get(id)
  if (m) return m
  const f = archivoSesion(id)
  if (existsSync(f)) {
    try {
      const s = JSON.parse(readFileSync(f, "utf8")) as Session
      sesiones.set(id, s)
      return s
    } catch {
      return undefined
    }
  }
  return undefined
}

export function limpiarSesiones() {
  sesiones.clear()
}

function persistir(s: Session) {
  try {
    mkdirSync(join(outDir(), "sessions"), { recursive: true })
    writeFileSync(archivoSesion(s.id), JSON.stringify(s, null, 2))
  } catch {
    /* la persistencia nunca rompe el turno */
  }
}

function registrarLog(sessionId: string, herramienta: string, ok: boolean, resumen: string) {
  try {
    mkdirSync(outDir(), { recursive: true })
    appendFileSync(join(outDir(), "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), sessionId, herramienta, ok, resumen }) + "\n")
  } catch {
    /* ignorar */
  }
}

function analizar(texto: string): { ok: boolean; resumen: string; pide: boolean; parsed: unknown } {
  try {
    const p = JSON.parse(texto) as { ok?: boolean; error?: string; data?: Record<string, unknown> }
    if (p.ok === false) {
      const e = String(p.error ?? "error")
      return { ok: false, resumen: e.slice(0, 300), pide: /requiere (confirmaci|revisi)/i.test(e), parsed: p }
    }
    const d = p.data ?? {}
    const conf = Array.isArray(d.confirmaciones) ? d.confirmaciones.length : 0
    const pendiente = d.pendiente_confirmacion === true || d.requiere_confirmacion === true
    const resumen = Object.entries(d)
      .slice(0, 6)
      .map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? (Array.isArray(v) ? `[${v.length}]` : "{…}") : String(v).slice(0, 40)}`)
      .join(", ")
    return { ok: true, resumen: resumen.slice(0, 300) || "ok", pide: conf > 0 || pendiente, parsed: p }
  } catch {
    return { ok: true, resumen: texto.slice(0, 200), pide: false, parsed: texto }
  }
}

export async function turno(llm: LlmAdapter, sessionId: string, mensaje: string): Promise<TurnoResultado> {
  let s = obtenerSesion(sessionId)
  if (!s) {
    s = { id: sessionId, messages: [{ role: "system", content: SYSTEM }], toolCalls: [], tokens: 0, creada: new Date().toISOString(), needsConfirmation: false }
    sesiones.set(sessionId, s)
  }
  const maxIter = num(process.env.MAX_ITERATIONS, 25)
  const maxTokens = num(process.env.MAX_TOKENS_SESSION, 200000)
  s.messages.push({ role: "user", content: mensaje })
  const usuarioConfirma = CONFIRMA.test(mensaje)
  const delTurno: ToolCallInfo[] = []
  let necesita = false
  let reply = ""

  try {
    for (let i = 0; i < maxIter; i++) {
      if (s.tokens >= maxTokens) {
        reply = "Se alcanzó el tope de tokens de esta sesión. Inicia una nueva sesión para continuar."
        s.messages.push({ role: "assistant", content: reply })
        break
      }
      const r = await llm.enviar(s.messages, definiciones())
      s.tokens += r.tokens.entrada + r.tokens.salida
      s.messages.push({ role: "assistant", content: r.texto, ...(r.llamadas.length ? { toolCalls: r.llamadas } : {}) })
      if (!r.llamadas.length) {
        reply = r.texto
        break
      }
      for (const c of r.llamadas) {
        let args: unknown
        try {
          args = JSON.parse(c.argumentos || "{}")
        } catch {
          args = {}
        }
        if (args && typeof args === "object" && (args as Record<string, unknown>).confirmado === true && !usuarioConfirma) {
          ;(args as Record<string, unknown>).confirmado = false
          registrarLog(sessionId, c.nombre, false, "confirmado:true forzado a false: el último mensaje del usuario no confirma")
        }
        const texto = await ejecutar(c.nombre, args, { directory: RAIZ, sessionId })
        const a = analizar(texto)
        if (a.pide && (!a.ok || !usuarioConfirma)) necesita = true
        const info: ToolCallInfo = { nombre: c.nombre, argumentos: args, ok: a.ok, resumen: a.resumen, resultado: a.parsed }
        delTurno.push(info)
        s.toolCalls.push(info)
        registrarLog(sessionId, c.nombre, a.ok, a.resumen)
        s.messages.push({ role: "tool", content: texto, toolCallId: c.id, name: c.nombre })
      }
      if (i === maxIter - 1) {
        s.messages.push({ role: "user", content: "[sistema] Se alcanzó el tope de iteraciones. Responde ahora con lo que tienes y lo que falta." })
        const f = await llm.enviar(s.messages, [])
        s.tokens += f.tokens.entrada + f.tokens.salida
        reply = f.texto || "Se alcanzó el tope de iteraciones antes de terminar."
        s.messages.push({ role: "assistant", content: reply })
      }
    }
  } catch (e) {
    reply = `No pude completar la respuesta: ${e instanceof Error ? e.message : String(e)} La sesión sigue activa; puedes reintentar.`
    s.messages.push({ role: "assistant", content: reply })
  }
  s.needsConfirmation = necesita
  persistir(s)
  return { reply, toolCalls: delTurno.map(({ resultado: _r, ...x }) => x), needsConfirmation: necesita }
}
