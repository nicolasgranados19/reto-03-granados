import { describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { analizar } from "../src/agent/loop"
import * as tools from "../src/tools/oc"

describe("needsConfirmation por elementos pendientes", () => {
  test("lista requiere_confirmacion no vacía marca pide", () => {
    const t = JSON.stringify({ ok: true, data: { llenos: [], requiere_confirmacion: [{ etiqueta: "RUC" }] } })
    expect(analizar(t).pide).toBe(true)
  })
  test("campo con estado requiere_confirmacion anidado marca pide", () => {
    const t = JSON.stringify({ ok: true, data: { campos: [{ etiqueta: "RUC", estado: "requiere_confirmacion" }] } })
    expect(analizar(t).pide).toBe(true)
  })
  test("requiere_revision o campos_por_confirmar no vacíos marcan pide", () => {
    expect(analizar(JSON.stringify({ ok: true, data: { requiere_revision: ["valor"] } })).pide).toBe(true)
    expect(analizar(JSON.stringify({ ok: true, data: { campos_por_confirmar: ["RUC"] } })).pide).toBe(true)
  })
  test("sin pendientes no marca pide", () => {
    const t = JSON.stringify({ ok: true, data: { llenos: [{ estado: "lleno" }], requiere_confirmacion: [], confirmaciones: [], requiere_revision: [] } })
    expect(analizar(t).pide).toBe(false)
  })
  test("validar: el resultado real de la tool marca pide", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reto03-loop-"))
    cpSync(join(import.meta.dir, "..", "fixtures"), join(dir, "fixtures"), { recursive: true })
    const r = await tools.validar.execute({ caso: "sol-004" } as never, { directory: dir, sessionId: "t" })
    expect(analizar(r).pide).toBe(true)
  })
})
