import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenAICompatible, esperaPara429 } from "../src/llm/openai-compatible"
import { compactar } from "../src/agent/loop"

const ok = { choices: [{ message: { content: "hola", tool_calls: [] } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }

function crear(fallos: unknown[]) {
  let llamadas = 0
  const esperas: number[] = []
  const logPath = join(mkdtempSync(join(tmpdir(), "llm-")), "out", "log.jsonl")
  const cliente = {
    chat: { completions: { create: async () => { const f = fallos[llamadas++]; if (f) throw f; return ok } } },
  }
  const llm = new OpenAICompatible({ LLM_MODEL: "m" }, { cliente: cliente as never, dormir: async (ms) => { esperas.push(ms) }, logPath })
  return { llm, esperas, logPath, llamadas: () => llamadas }
}
const e429 = (headers: Record<string, string> = {}) => Object.assign(new Error("429"), { status: 429, headers })

describe("reintento ante 429", () => {
  test("dos 429 y luego éxito: usa retry-after-ms, registra cada reintento", async () => {
    const t = crear([e429({ "retry-after-ms": "1200" }), e429({ "retry-after": "3" })])
    const r = await t.llm.enviar([{ role: "user", content: "hi" }], [])
    expect(r.texto).toBe("hola")
    expect(t.llamadas()).toBe(3)
    expect(t.esperas).toEqual([1200, 3000])
    expect(t.llm.reintentos).toBe(2)
    const lineas = readFileSync(t.logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.herramienta === "llm_reintento")
    expect(lineas.length).toBe(2)
    expect(lineas[0].resumen).toContain("reintento 1/4")
  })
  test("sin headers usa backoff 5 s, 15 s, 30 s", async () => {
    const t = crear([e429(), e429(), e429()])
    await t.llm.enviar([{ role: "user", content: "hi" }], [])
    expect(t.esperas).toEqual([5000, 15000, 30000])
  })
  test("tras 4 reintentos falla con mensaje claro", async () => {
    const t = crear([e429(), e429(), e429(), e429(), e429()])
    await expect(t.llm.enviar([{ role: "user", content: "hi" }], [])).rejects.toThrow(/429/)
    expect(t.llamadas()).toBe(5)
  })
  test("otros errores no se reintentan", async () => {
    const t = crear([Object.assign(new Error("x"), { status: 401 })])
    await expect(t.llm.enviar([{ role: "user", content: "hi" }], [])).rejects.toThrow(/credenciales/)
    expect(t.llamadas()).toBe(1)
  })
  test("esperaPara429 acepta Headers reales", () => {
    expect(esperaPara429({ headers: new Headers({ "retry-after": "7" }) }, 0)).toBe(7000)
  })
})

describe("historial compacto", () => {
  test("trunca a 1500 caracteres y avisa cuántos se quitaron", () => {
    const t = "a".repeat(4000)
    const c = compactar(t)
    expect(c.startsWith("a".repeat(1500))).toBe(true)
    expect(c.endsWith("[truncado: 2500 caracteres]")).toBe(true)
    expect(t.length).toBe(4000)
  })
  test("no toca los resultados cortos", () => {
    expect(compactar("corto")).toBe("corto")
    expect(existsSync("x")).toBe(false)
  })
})
