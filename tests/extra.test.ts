import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LlmAdapter, Mensaje, RespuestaLlm } from "../src/llm/adapter"
import { OpenAICompatible } from "../src/llm/openai-compatible"
import { RAIZ, turno } from "../src/agent/loop"

const firma = { google: { thought_signature: "FIRMA-OPACA-123==" } }
const llamadaGemini = { id: "call_1", type: "function", function: { name: "x_y", arguments: "{}" }, extra_content: firma }
const llamadaGroq = { id: "call_2", type: "function", function: { name: "x_y", arguments: "{}" } }

function crear(respuestas: unknown[], env: Record<string, string> = { LLM_MODEL: "m" }) {
  const cuerpos: { messages: Record<string, unknown>[] }[] = []
  let i = 0
  const logPath = join(mkdtempSync(join(tmpdir(), "extra-")), "out", "log.jsonl")
  const cliente = {
    chat: {
      completions: {
        create: async (cuerpo: { messages: Record<string, unknown>[] }) => {
          cuerpos.push(JSON.parse(JSON.stringify(cuerpo)))
          const r = respuestas[i++]
          if (r instanceof Error) throw r
          return r
        },
      },
    },
  }
  return { llm: new OpenAICompatible(env, { cliente: cliente as never, dormir: async () => {}, logPath }), cuerpos, logPath }
}
const respuesta = (tool_calls: unknown[]) => ({ choices: [{ message: { content: "", tool_calls } }], usage: { prompt_tokens: 5, completion_tokens: 1 } })
const final = { choices: [{ message: { content: "listo", tool_calls: [] } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }

describe("extra_content (thought_signature de Gemini)", () => {
  test("se guarda en extra y se reenvía sin cambios", async () => {
    const t = crear([respuesta([llamadaGemini]), final])
    const r1 = await t.llm.enviar([{ role: "user", content: "hola" }], [])
    expect(r1.llamadas[0]?.extra).toEqual({ extra_content: firma })
    const hist: Mensaje[] = [
      { role: "user", content: "hola" },
      { role: "assistant", content: "", toolCalls: r1.llamadas },
      { role: "tool", content: "{}", toolCallId: "call_1", name: "x_y" },
    ]
    await t.llm.enviar(hist, [])
    const enviado = t.cuerpos[1]?.messages[1] as { tool_calls: Record<string, unknown>[] }
    expect(enviado.tool_calls[0]?.extra_content).toEqual(firma)
    expect(enviado.tool_calls[0]?.id).toBe("call_1")
  })
  test("sin extra_content el payload no cambia (Groq)", async () => {
    const t = crear([respuesta([llamadaGroq]), final])
    const r1 = await t.llm.enviar([{ role: "user", content: "hola" }], [])
    expect(r1.llamadas[0]).toEqual({ id: "call_2", nombre: "x_y", argumentos: "{}" })
    expect("extra" in (r1.llamadas[0] ?? {})).toBe(false)
    await t.llm.enviar([{ role: "assistant", content: "", toolCalls: r1.llamadas }], [])
    const enviado = t.cuerpos[1]?.messages[0] as { tool_calls: unknown[] }
    expect(enviado.tool_calls).toEqual([{ id: "call_2", type: "function", function: { name: "x_y", arguments: "{}" } }])
  })
})

describe("log del error del proveedor", () => {
  test("registra el mensaje del 4xx sin la clave", async () => {
    const e = Object.assign(new Error("400 Function call is missing a thought_signature. key=SECRETO-XYZ"), { status: 400 })
    const t = crear([e], { LLM_MODEL: "m", LLM_API_KEY: "SECRETO-XYZ" })
    await expect(t.llm.enviar([{ role: "user", content: "hola" }], [])).rejects.toThrow()
    const log = readFileSync(t.logPath, "utf-8")
    expect(log).toContain("thought_signature")
    expect(log).toContain("HTTP 400")
    expect(log).not.toContain("SECRETO-XYZ")
  })
  test("un 429 también deja su mensaje", async () => {
    const e = Object.assign(new Error("429 Rate limit reached for TPM: Limit 8000, Used 7900"), { status: 429, headers: { "retry-after-ms": "1" } })
    const t = crear([e, final])
    await t.llm.enviar([{ role: "user", content: "hola" }], [])
    const log = readFileSync(t.logPath, "utf-8")
    expect(log).toContain("llm_error")
    expect(log).toContain("Rate limit reached for TPM")
  })
})

describe("el loop y la sesión conservan extra", () => {
  test("messages en memoria y out/sessions/<id>.json", async () => {
    const id = `test-extra-${Date.now()}`
    const vistos: Mensaje[][] = []
    let n = 0
    const llm: LlmAdapter = {
      proveedor: "falso",
      modelo: "falso",
      async enviar(mensajes): Promise<RespuestaLlm> {
        vistos.push(JSON.parse(JSON.stringify(mensajes)))
        n++
        if (n === 1) return { texto: "", llamadas: [{ id: "c1", nombre: "inexistente_x", argumentos: "{}", extra: { extra_content: firma } }], tokens: { entrada: 1, salida: 1 } }
        return { texto: "ok", llamadas: [], tokens: { entrada: 1, salida: 1 } }
      },
    }
    try {
      await turno(llm, id, "hola")
      const segunda = vistos[1]?.find((m) => m.role === "assistant" && m.toolCalls)
      expect(segunda?.toolCalls?.[0]?.extra).toEqual({ extra_content: firma })
      const archivo = join(RAIZ, "out", "sessions", `${id}.json`)
      expect(existsSync(archivo)).toBe(true)
      expect(readFileSync(archivo, "utf-8")).toContain("FIRMA-OPACA-123==")
    } finally {
      rmSync(join(RAIZ, "out", "sessions", `${id}.json`), { force: true })
    }
  })
})
