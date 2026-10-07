import { beforeEach, describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { inferirUnidad, miles, montoAprobadoExplicito, normalizarNit, parseMonto } from "../src/lib/oc-core"
import { OrdenCompraSchema } from "../src/sap/adapter"
import * as oc from "../src/tools/oc"

type Json = Record<string, any>
let dir = ""
const ctx = () => ({ directory: dir, sessionId: "t" })
const run = async (tool: { execute(a: never, c: ReturnType<typeof ctx>): Promise<string> }, args: Record<string, unknown>) =>
  JSON.parse(await tool.execute(args as never, ctx())) as Json
const codigos = (xs: Json[]) => xs.map((x) => x.codigo as string)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-"))
  cpSync(join(import.meta.dir, "..", "fixtures"), join(dir, "fixtures"), { recursive: true })
})

describe("utilidades", () => {
  test("NIT con DV se normaliza", () => {
    expect(normalizarNit("900.555.111-2")).toBe("900555111")
    expect(normalizarNit("900555111")).toBe("900555111")
  })
  test("montos: punto de miles en COP, coma de miles en USD", () => {
    expect(parseMonto("11.400.000", "COP")).toBe(11400000)
    expect(parseMonto("120,000.50", "USD")).toBe(120000.5)
    expect(miles(11400000)).toBe("11.400.000")
  })
  test("unidad", () => {
    expect(inferirUnidad("Bolsa de 100 horas de arquitectura")).toBe("H")
    expect(inferirUnidad("Servicio mensual de soporte")).toBe("MES")
    expect(inferirUnidad("licencias, vigencia 12 meses")).toBe("UN")
  })
  test("monto aprobado explícito", () => {
    expect(montoAprobadoExplicito("Aprobado por 25 millones según la solicitud.")).toBe(25_000_000)
    expect(montoAprobadoExplicito("Aprobado.")).toBeNull()
  })
})

describe("contrato de herramientas", () => {
  test("todas tienen description y .describe() en cada arg", () => {
    for (const [nombre, t] of Object.entries(oc)) {
      expect(t.description.length).toBeGreaterThan(10)
      for (const [k, schema] of Object.entries(t.args)) {
        expect((schema as z.ZodType).description, `${nombre}.${k}`).toBeTruthy()
      }
    }
    expect(Object.keys(oc).sort()).toEqual(["construir_payload", "crear", "generar_evidencia", "leer_paquete", "validar"])
  })
  test("caso inexistente devuelve error legible y no lanza", async () => {
    for (const t of [oc.leer_paquete, oc.validar, oc.generar_evidencia, oc.construir_payload, oc.crear]) {
      const r = await run(t, { caso: "no-existe" })
      expect(r.ok).toBe(false)
      expect(typeof r.error).toBe("string")
    }
  })
})

describe("leer_paquete", () => {
  test("normaliza sol-001 (NIT sin DV, total con punto de miles, correos con tildes)", async () => {
    const r = await run(oc.leer_paquete, { caso: "sol-001" })
    expect(r.ok).toBe(true)
    expect(r.data.cotizacion.total).toBe(11400000)
    expect(r.data.cotizacion.nit).toBe("900555111")
    expect(r.data.cotizacion.validez_hasta).toBe("2026-09-17")
    expect(r.data.factura).toBeNull()
    const t = await run(oc.leer_paquete, { caso: "sol-004" })
    expect(t.data.correo.de).toBe("natalia.ríos@periferia-ficticia.com")
  })
  test("sol-005 trae factura", async () => {
    const r = await run(oc.leer_paquete, { caso: "sol-005" })
    expect(r.data.factura).toEqual({ numero: "FC-88231", fecha: "2026-08-10", total: 3200000 })
  })
  test("adjunto ausente se reporta como null con su nombre", async () => {
    const base = join(dir, "fixtures/reto-03/solicitudes")
    cpSync(join(base, "sol-001"), join(base, "x-1"), { recursive: true })
    rmSync(join(base, "x-1/cotizacion.txt"))
    const r = await run(oc.leer_paquete, { caso: "x-1" })
    expect(r.ok).toBe(true)
    expect(r.data.cotizacion).toBeNull()
    expect(r.data.faltantes).toContain("cotizacion.txt")
  })
  test("monto no numérico y JSON malformado dan error legible", async () => {
    const base = join(dir, "fixtures/reto-03/solicitudes")
    cpSync(join(base, "sol-001"), join(base, "mal-1"), { recursive: true })
    const sol = JSON.parse(readFileSync(join(base, "mal-1/solicitud.json"), "utf8")) as Json
    writeFileSync(join(base, "mal-1/solicitud.json"), JSON.stringify({ ...sol, valor_total: "mucho" }))
    const r1 = await run(oc.leer_paquete, { caso: "mal-1" })
    expect(r1.ok).toBe(false)
    expect(r1.error).toContain("valor_total")
    writeFileSync(join(base, "mal-1/solicitud.json"), "{ no es json")
    const r2 = await run(oc.leer_paquete, { caso: "mal-1" })
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain("malformado")
  })
})

describe("validar (RC1-RC10) sobre los 6 casos", () => {
  test("sol-001 apta sin confirmaciones", async () => {
    const v = (await run(oc.validar, { caso: "sol-001" })).data
    expect(v.apta).toBe(true)
    expect(v.confirmaciones).toEqual([])
    expect(v.retroactiva).toBe(false)
  })
  test("sol-002 bloquea RC1 con acción sugerida", async () => {
    const v = (await run(oc.validar, { caso: "sol-002" })).data
    expect(v.apta).toBe(false)
    expect(codigos(v.bloqueos)).toEqual(["PROVEEDOR_NO_EXISTE"])
    expect(v.bloqueos[0].accion_sugerida).toContain("solicitar creación del proveedor")
  })
  test("sol-003 bloquea RC2 y RC3 y sugiere CC-3030", async () => {
    const v = (await run(oc.validar, { caso: "sol-003" })).data
    expect(codigos(v.bloqueos)).toEqual(["APROBADOR_NO_AUTORIZADO", "MONTO_EXCEDE_TOPE"])
    expect(v.acciones_sugeridas.join(" ")).toContain("CC-3030")
    expect(v.acciones_sugeridas.join(" ")).toContain("80.000.000")
  })
  test("sol-004 pide confirmación RC5 con ambos valores y monto aprobado", async () => {
    const v = (await run(oc.validar, { caso: "sol-004" })).data
    expect(v.apta).toBe(true)
    expect(codigos(v.confirmaciones)).toEqual(["COTIZACION_DIFIERE", "MONTO_APROBADO_EXPLICITO"])
    expect(v.confirmaciones[0].detalle).toContain("26.500.000")
    expect(v.confirmaciones[0].detalle).toContain("25.000.000")
  })
  test("sol-005 es retroactiva y pide confirmación", async () => {
    const v = (await run(oc.validar, { caso: "sol-005" })).data
    expect(v.retroactiva).toBe(true)
    expect(codigos(v.confirmaciones)).toEqual(["RETROACTIVA"])
  })
  test("sol-006 busca por nombre, deriva IVA (confirma) y pago (informa)", async () => {
    const v = (await run(oc.validar, { caso: "sol-006" })).data
    expect(v.apta).toBe(true)
    expect(v.derivados.indicador_iva.valor).toBe("C1")
    expect(v.derivados.condiciones_pago.valor).toBe("Z030")
    expect(codigos(v.confirmaciones)).toEqual(["IVA_DERIVADO"])
  })
})

describe("evidencia y payload", () => {
  test("evidencia txt + pdf con sha256 estable", async () => {
    const a = await run(oc.generar_evidencia, { caso: "sol-001" })
    const b = await run(oc.generar_evidencia, { caso: "sol-001" })
    expect(a.data.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(a.data.sha256).toBe(b.data.sha256)
    expect(existsSync(join(dir, "out/sol-001/aprobacion.pdf"))).toBe(true)
    const txt = readFileSync(join(dir, "out/sol-001/aprobacion.txt"), "utf8")
    expect(txt).toContain("De: mlopez@")
    expect(txt).toContain(`sha256: ${a.data.sha256}`)
  })
  test("payload sol-001 válido, descripción truncada, trazabilidad completa", async () => {
    const r = await run(oc.construir_payload, { caso: "sol-001" })
    expect(r.ok).toBe(true)
    const p = OrdenCompraSchema.parse(r.data.payload)
    expect(p.posiciones[0]?.descripcion.length).toBeLessThanOrEqual(40)
    expect(p.posiciones[0]?.unidad).toBe("UN")
    expect(p.excepciones.map((e) => e.codigo)).toContain("DESCRIPCION_TRUNCADA")
    const t = JSON.parse(readFileSync(join(dir, "out/sol-001/trazabilidad.json"), "utf8")) as Json
    expect(t.valores.every((v: Json) => typeof v.fuente === "string" && v.fuente.length > 0)).toBe(true)
    expect(t.valores.find((v: Json) => v.campo === "proveedor.codigo_sap").fuente).toBe("maestro.proveedores")
    expect(t.notas.join(" ")).toContain("posible doble IVA en SAP")
  })
  test("payload sol-004 usa el valor de la solicitud y unidad H; sol-006 usa derivados", async () => {
    const p4 = (await run(oc.construir_payload, { caso: "sol-004" })).data.payload
    expect(p4.posiciones[0].precio_unitario).toBe(250000)
    expect(p4.posiciones[0].unidad).toBe("H")
    const p6 = (await run(oc.construir_payload, { caso: "sol-006" })).data.payload
    expect(p6.condiciones_pago).toBe("Z030")
    expect(p6.posiciones[0].indicador_iva).toBe("C1")
  })
  test("no construye payload de un caso bloqueado", async () => {
    const r = await run(oc.construir_payload, { caso: "sol-002" })
    expect(r.ok).toBe(false)
  })
})

describe("crear", () => {
  test("sol-001 crea 4500000001 y es idempotente", async () => {
    const a = await run(oc.crear, { caso: "sol-001" })
    expect(a.data.numero_oc).toBe("4500000001")
    expect(a.data.idempotente).toBe(false)
    const b = await run(oc.crear, { caso: "sol-001" })
    expect(b.data.numero_oc).toBe("4500000001")
    expect(b.data.idempotente).toBe(true)
    const lineas = readFileSync(join(dir, "out/sap/ordenes.jsonl"), "utf8").trim().split("\n")
    expect(lineas.length).toBe(1)
  })
  test("sol-002 y sol-003 no crean OC", async () => {
    for (const caso of ["sol-002", "sol-003"]) {
      const r = await run(oc.crear, { caso, confirmado: true })
      expect(r.ok).toBe(false)
      expect(r.error).toContain("bloqueada")
    }
    expect(existsSync(join(dir, "out/sap/ordenes.jsonl"))).toBe(false)
  })
  test("sol-004 exige confirmación y luego crea; confirmado_por queda en las excepciones", async () => {
    const p = await run(oc.crear, { caso: "sol-004" })
    expect(p.ok).toBe(false)
    expect(p.error).toContain("requiere confirmación")
    const c = await run(oc.crear, { caso: "sol-004", confirmado: true })
    expect(c.ok).toBe(true)
    const reg = JSON.parse(readFileSync(join(dir, "out/sap/ordenes.jsonl"), "utf8").trim()) as Json
    expect(reg.orden.excepciones[0].confirmado_por).toBeTruthy()
  })
  test("payload manipulado es rechazado", async () => {
    const { payload } = (await run(oc.construir_payload, { caso: "sol-001" })).data
    payload.posiciones[0].precio_unitario = 1
    const r = await run(oc.crear, { caso: "sol-001", payload })
    expect(r.ok).toBe(false)
    expect(r.error).toContain("no coincide")
  })
  test("control.csv registra creada, bloqueada, pendiente y retroactiva", async () => {
    await run(oc.crear, { caso: "sol-002" })
    await run(oc.crear, { caso: "sol-005" })
    await run(oc.crear, { caso: "sol-005", confirmado: true })
    const filas = readFileSync(join(dir, "out/control.csv"), "utf8").trim().split("\n")
    expect(filas[0]).toBe("solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts")
    expect(filas[1]).toContain("SOL-2026-002,bloqueada,,false,PROVEEDOR_NO_EXISTE")
    expect(filas[2]).toContain("SOL-2026-005,pendiente,,true,,RETROACTIVA")
    expect(filas[3]).toContain("SOL-2026-005,creada,4500000001,true")
  })
})
