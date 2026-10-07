import { z } from "zod"
import {
  construirOrden, escribirTrazabilidad, evaluar, fallo, generarEvidencia, leerPaquete, ok, registrarControl,
  salida, stableStringify, type Paquete, type Resultado,
} from "../lib/oc-core"
import { OrdenCompraSchema, type OrdenCompra } from "../sap/adapter"
import { SapMock } from "../sap/mock"

type Ctx = { directory: string; sessionId: string }

const caso = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "solo letras, números, guion y guion bajo")
  .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo sol-001")
const paqueteArg = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Paquete devuelto por oc_leer_paquete (opcional: las herramientas siempre releen el caso desde disco)")

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Ejecuta la herramienta sin que nunca lance. */
async function seguro(f: () => Promise<Resultado<unknown>> | Resultado<unknown>): Promise<string> {
  try {
    return salida(await f())
  } catch (e) {
    return salida(fallo(`Error inesperado: ${msg(e)}`))
  }
}

function cargar(dir: string, c: string): Resultado<{ paquete: Paquete; faltantes: string[] }> {
  return leerPaquete(dir, c)
}

export const leer_paquete = {
  description: "Lee el paquete del caso (correo, solicitud, cotización, aprobación y factura) y lo devuelve normalizado.",
  args: { caso },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return seguro(() => {
      const r = cargar(ctx.directory, args.caso)
      if (!r.ok) return r
      return ok({ ...r.data.paquete, faltantes: r.data.faltantes })
    })
  },
}

export const validar = {
  description: "Valida el caso contra maestros y reglas RC1-RC10 y devuelve apta, bloqueos, confirmaciones, derivados y retroactiva.",
  args: { caso, paquete: paqueteArg },
  async execute(args: { caso: string; paquete?: Record<string, unknown> }, ctx: Ctx): Promise<string> {
    return seguro(() => {
      const r = cargar(ctx.directory, args.caso)
      if (!r.ok) return r
      return ok(evaluar(ctx.directory, r.data.paquete).validacion)
    })
  },
}

export const generar_evidencia = {
  description: "Genera la evidencia de aprobación (aprobacion.txt y aprobacion.pdf con sha256) en out/<caso>/.",
  args: { caso },
  async execute(args: { caso: string }, ctx: Ctx): Promise<string> {
    return seguro(async () => {
      const r = cargar(ctx.directory, args.caso)
      if (!r.ok) return r
      return generarEvidencia(ctx.directory, args.caso, r.data.paquete)
    })
  },
}

async function armar(dir: string, c: string): Promise<Resultado<{ orden: OrdenCompra; validacion: ReturnType<typeof evaluar>["validacion"]; ruta_trazabilidad: string; evidencia: string }>> {
  const r = cargar(dir, c)
  if (!r.ok) return r
  const { validacion, proveedor } = evaluar(dir, r.data.paquete)
  if (!validacion.apta || !proveedor) {
    return fallo(`No se puede construir el payload: el caso tiene bloqueos (${validacion.bloqueos.map((b) => b.codigo).join(", ")}).`)
  }
  const ev = await generarEvidencia(dir, c, r.data.paquete)
  if (!ev.ok) return ev
  const { orden, trazabilidad } = construirOrden(r.data.paquete, validacion, proveedor, ev.data.sha256, c)
  const ruta_trazabilidad = escribirTrazabilidad(dir, c, trazabilidad)
  return ok({ orden, validacion, ruta_trazabilidad, evidencia: ev.data.ruta })
}

export const construir_payload = {
  description: "Construye la orden de compra tal como quedaría en SAP (validada con zod) y guarda su trazabilidad por valor.",
  args: {
    caso,
    paquete: paqueteArg,
    derivados: z.record(z.string(), z.unknown()).optional().describe("Derivados devueltos por oc_validar (opcional: se recalculan siempre)"),
  },
  async execute(args: { caso: string; paquete?: Record<string, unknown>; derivados?: Record<string, unknown> }, ctx: Ctx): Promise<string> {
    return seguro(async () => {
      const r = await armar(ctx.directory, args.caso)
      if (!r.ok) return r
      return ok({ payload: r.data.orden, ruta_trazabilidad: r.data.ruta_trazabilidad, evidencia: r.data.evidencia })
    })
  },
}

export const crear = {
  description: "Crea la OC en el SAP simulado si el caso es apto y está confirmado; es idempotente por solicitud_id y registra el intento en out/control.csv.",
  args: {
    caso,
    payload: z.record(z.string(), z.unknown()).optional().describe("Payload devuelto por oc_construir_payload (opcional; si se envía debe coincidir con el validado)"),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente las confirmaciones pendientes en su último mensaje"),
  },
  async execute(args: { caso: string; payload?: Record<string, unknown>; confirmado?: boolean }, ctx: Ctx): Promise<string> {
    return seguro(async () => {
      const dir = ctx.directory
      const r = cargar(dir, args.caso)
      if (!r.ok) return r
      const { solicitud_id } = r.data.paquete.solicitud
      const { validacion } = evaluar(dir, r.data.paquete)
      const bloq = validacion.bloqueos.map((b) => b.codigo)
      const conf = validacion.confirmaciones.map((c) => c.codigo)
      const fila = { solicitud_id, retroactiva: validacion.retroactiva, bloqueos: bloq, confirmaciones: conf }
      const sap = new SapMock(dir)

      const existente = await sap.buscarOrdenPorReferencia(solicitud_id)
      if (existente) {
        registrarControl(dir, { ...fila, resultado: "idempotente", numero_oc: existente.numero_oc })
        return ok({ numero_oc: existente.numero_oc, fecha: null, idempotente: true, retroactiva: validacion.retroactiva })
      }
      if (!validacion.apta) {
        registrarControl(dir, { ...fila, resultado: "bloqueada", numero_oc: "" })
        return fallo(`OC bloqueada: ${bloq.join(", ")}`, { bloqueos: validacion.bloqueos, acciones_sugeridas: validacion.acciones_sugeridas })
      }
      if (conf.length > 0 && args.confirmado !== true) {
        registrarControl(dir, { ...fila, resultado: "pendiente", numero_oc: "" })
        return fallo(`requiere confirmación: ${conf.join(", ")}`, { confirmaciones: validacion.confirmaciones })
      }

      const a = await armar(dir, args.caso)
      if (!a.ok) return a
      if (args.payload) {
        const dado = OrdenCompraSchema.safeParse(args.payload)
        if (!dado.success) return fallo("El payload enviado no cumple el esquema de la OC; vuelve a llamar a oc_construir_payload.")
        const sinExc = (o: OrdenCompra) => stableStringify({ ...o, excepciones: undefined })
        if (sinExc(dado.data) !== sinExc(a.data.orden)) {
          return fallo("El payload enviado no coincide con el validado por las herramientas; vuelve a llamar a oc_construir_payload.")
        }
      }
      const confirmadoPor = args.confirmado === true ? "analista (chat)" : null
      const orden: OrdenCompra = {
        ...a.data.orden,
        excepciones: a.data.orden.excepciones.map((e) => ({ ...e, confirmado_por: conf.includes(e.codigo) ? confirmadoPor : null })),
      }
      const creada = await sap.crearOrden(orden)
      registrarControl(dir, { ...fila, resultado: "creada", numero_oc: creada.numero_oc })
      return ok({ numero_oc: creada.numero_oc, fecha: creada.fecha, idempotente: false, retroactiva: validacion.retroactiva, evidencia: a.data.evidencia, trazabilidad: a.data.ruta_trazabilidad })
    })
  },
}
