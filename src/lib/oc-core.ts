import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { z } from "zod"
import { OrdenCompraSchema, type OrdenCompra } from "../sap/adapter"

// ---------- Tipos ----------

export type Solicitud = z.infer<typeof SolicitudSchema>
export type Cotizacion = {
  referencia: string | null
  proveedor: string
  nit: string | null
  total: number
  moneda: string
  validez_hasta: string | null
  texto: string
}
export type Aprobacion = { de: string; para: string; asunto: string; fecha: string; aprobado: boolean; texto: string }
export type Factura = { numero: string; fecha: string; total: number }
export type Paquete = {
  correo: { id: string; de: string; asunto: string; fecha: string }
  solicitud: Solicitud
  cotizacion: Cotizacion | null
  aprobacion: Aprobacion | null
  factura: Factura | null
}
export type Bloqueo = { codigo: string; regla: string; detalle: string; accion_sugerida: string }
export type Confirmacion = { codigo: string; regla: string; detalle: string }
export type Derivado = { valor: string; fuente: string; detalle: string }
export type Validacion = {
  apta: boolean
  bloqueos: Bloqueo[]
  confirmaciones: Confirmacion[]
  derivados: Record<string, Derivado>
  retroactiva: boolean
  acciones_sugeridas: string[]
}
type Proveedor = {
  codigo_sap: string
  nit: string
  nombre: string
  condiciones_pago_default: string
  indicador_iva_default: string
  activo: boolean
}
type CentroCosto = { centro_costo: string; subareas: string[]; aprobadores: { email: string; tope: number }[] }
type Maestros = {
  proveedores: Proveedor[]
  centros: CentroCosto[]
  iva: { codigo: string; tasa: number }[]
  pagos: { codigo: string }[]
}
export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string; [k: string]: unknown }

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "debe ser una fecha YYYY-MM-DD")
// Los correos traen tildes (sofía.herrera@...): no se usa z.email().
export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string().min(1),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number({ error: "debe ser numérico" }),
  valor_unitario: z.number({ error: "debe ser numérico" }),
  valor_total: z.number({ error: "debe ser numérico" }).positive("debe ser mayor que cero"),
  moneda: z.string().min(1),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: fecha,
})

// ---------- Utilidades ----------

export const miles = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")
const sinTildes = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
export const normalizarNombre = (s: string) => sinTildes(s).toLowerCase().replace(/[^a-z0-9]/g, "")
/** "900.555.111-2" → "900555111" (quita puntos y dígito de verificación). */
export function normalizarNit(s: string): string {
  const limpio = s.replace(/[.\s]/g, "")
  const m = limpio.match(/^(\d+)-\d$/)
  return m?.[1] ?? limpio.replace(/\D/g, "")
}
/** Solo la parte YYYY-MM-DD local; las fechas llegan con -05:00. */
export const dia = (iso: string) => iso.slice(0, 10)
/** Punto = miles en COP; coma = miles en USD. */
export function parseMonto(texto: string, moneda: string): number {
  const t = texto.trim()
  const n = moneda === "USD" ? Number(t.replace(/,/g, "")) : Number(t.replace(/\./g, "").replace(",", "."))
  return n
}
const mensajeError = (e: unknown) => (e instanceof Error ? e.message : String(e))
export const ok = <T>(data: T): Resultado<T> => ({ ok: true, data })
export const fallo = (error: string, extra: Record<string, unknown> = {}): Resultado<never> => ({ ...extra, ok: false, error })
export const salida = <T>(r: Resultado<T>): string => JSON.stringify(r)
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`
  }
  return JSON.stringify(v)
}

const rutaFixtures = (dir: string) => join(dir, "fixtures", "reto-03")
const rutaCaso = (dir: string, caso: string) => join(rutaFixtures(dir), "solicitudes", caso)
export const rutaOut = (dir: string, caso: string) => join(dir, "out", caso)

function leerJson(ruta: string, nombre: string): unknown {
  try {
    return JSON.parse(readFileSync(ruta, "utf8"))
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`${nombre} está malformado (JSON inválido)`)
    throw e
  }
}

function leerMaestros(dir: string): Maestros {
  const m = (n: string) => leerJson(join(rutaFixtures(dir), "maestros", n), n)
  return {
    proveedores: m("proveedores.json") as Proveedor[],
    centros: m("centros-costo.json") as CentroCosto[],
    iva: m("indicadores-iva.json") as Maestros["iva"],
    pagos: m("condiciones-pago.json") as Maestros["pagos"],
  }
}

// ---------- Lectura del paquete ----------

function sumarDias(iso: string, dias: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

export function parsearCotizacion(texto: string): Cotizacion | null {
  const campo = (re: RegExp) => texto.match(re)?.[1]?.trim()
  const moneda = campo(/TOTAL[^:\n]*:\s*(COP|USD)/i) ?? "COP"
  const totalTxt = campo(/TOTAL[^:\n]*:\s*(?:COP|USD)?\s*\$?\s*([\d.,]+)/i)
  const total = totalTxt ? parseMonto(totalTxt, moneda) : NaN
  if (!Number.isFinite(total)) return null
  const nitTxt = campo(/NIT:\s*([\d.\-]+)/i)
  const fechaCot = campo(/Fecha:\s*(\d{4}-\d{2}-\d{2})/i)
  const validezDias = campo(/Validez de la oferta:\s*(\d+)/i)
  return {
    referencia: campo(/^COTIZACI[ÓO]N\s+(\S+)/im) ?? null,
    proveedor: campo(/Proveedor:\s*(.+)/i) ?? "",
    nit: nitTxt ? normalizarNit(nitTxt) : null,
    total,
    moneda,
    validez_hasta: fechaCot && validezDias ? sumarDias(fechaCot, Number(validezDias)) : null,
    texto,
  }
}

export function parsearFactura(texto: string): Factura | null {
  const numero = texto.match(/No\.\s*(\S+)/i)?.[1]
  const f = texto.match(/Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i)?.[1]
  const totalTxt = texto.match(/TOTAL:\s*(?:COP|USD)?\s*\$?\s*([\d.,]+)/i)?.[1]
  if (!numero || !f || !totalTxt) return null
  return { numero, fecha: f, total: parseMonto(totalTxt, "COP") }
}

function leerAprobacion(ruta: string): Aprobacion {
  const raw = leerJson(ruta, "aprobacion.json")
  const a = z
    .object({
      de: z.string(),
      para: z.string().default(""),
      fecha: z.string(),
      asunto: z.string().default(""),
      cuerpo: z.string(),
    })
    .parse(raw)
  return { de: a.de, para: a.para, asunto: a.asunto, fecha: a.fecha, aprobado: /\baprobad[oa]\b/i.test(a.cuerpo), texto: a.cuerpo }
}

export function leerPaquete(dir: string, caso: string): Resultado<{ paquete: Paquete; faltantes: string[] }> {
  try {
    const carpeta = rutaCaso(dir, caso)
    if (!existsSync(carpeta)) return fallo(`El caso "${caso}" no existe en fixtures/reto-03/solicitudes/`)
    const faltantes: string[] = []
    const f = (n: string) => join(carpeta, n)
    if (!existsSync(f("correo.json"))) return fallo("Falta correo.json: pide al solicitante reenviar el correo original")
    if (!existsSync(f("solicitud.json"))) return fallo("Falta solicitud.json: pide al solicitante el Excel de solicitud")

    const correo = z
      .object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string() })
      .parse(leerJson(f("correo.json"), "correo.json"))
    const sol = SolicitudSchema.safeParse(leerJson(f("solicitud.json"), "solicitud.json"))
    if (!sol.success) {
      const det = sol.error.issues.map((i) => `${i.path.join(".") || "solicitud"}: ${i.message}`).join("; ")
      return fallo(`La solicitud es inválida (${det}). Pide al solicitante corregir el Excel.`)
    }

    let cotizacion: Cotizacion | null = null
    if (existsSync(f("cotizacion.txt"))) {
      cotizacion = parsearCotizacion(readFileSync(f("cotizacion.txt"), "utf8"))
      if (!cotizacion) faltantes.push("cotizacion.txt (ilegible: no se encontró el TOTAL)")
    } else faltantes.push("cotizacion.txt")

    let aprobacion: Aprobacion | null = null
    if (existsSync(f("aprobacion.json"))) aprobacion = leerAprobacion(f("aprobacion.json"))
    else faltantes.push("aprobacion.json")

    const factura = existsSync(f("factura.txt")) ? parsearFactura(readFileSync(f("factura.txt"), "utf8")) : null
    return ok({ paquete: { correo, solicitud: sol.data, cotizacion, aprobacion, factura }, faltantes })
  } catch (e) {
    return fallo(`No se pudo leer el paquete "${caso}": ${mensajeError(e)}`)
  }
}

// ---------- Validación (RC1–RC10) ----------

function buscarProveedor(m: Maestros, s: Solicitud): Proveedor | null {
  if (s.proveedor_nit) {
    const nit = normalizarNit(s.proveedor_nit)
    return m.proveedores.find((p) => p.nit === nit) ?? null
  }
  const n = normalizarNombre(s.proveedor_nombre)
  return m.proveedores.find((p) => normalizarNombre(p.nombre) === n) ?? null
}

/** Busca un centro/subárea cuyo nombre aparezca en el texto de la aprobación y cuyo aprobador cubra el monto. */
function sugerirCentro(m: Maestros, p: Paquete): string | null {
  const ap = p.aprobacion
  if (!ap) return null
  const texto = normalizarNombre(ap.texto)
  for (const cc of m.centros) {
    if (cc.centro_costo === p.solicitud.centro_costo) continue
    const sub = cc.subareas.find((s) => texto.includes(normalizarNombre(s)))
    const aprob = cc.aprobadores.find((a) => a.email.toLowerCase() === ap.de.toLowerCase())
    if (sub && aprob && aprob.tope >= p.solicitud.valor_total) {
      return `El texto de la aprobación menciona "${sub.toLowerCase()}", que es de ${cc.centro_costo}, cuyo tope (${miles(aprob.tope)}) sí cubre el monto: se recomienda corregir centro de costos a ${cc.centro_costo} y subárea a ${sub}.`
    }
  }
  return null
}

export function montoAprobadoExplicito(texto: string): number | null {
  const m = texto.match(/aprobad[oa]\s+por\s+(?:COP\s*)?\$?\s*([\d.,]+)\s*(millones|mill[óo]n|mm)?/i)
  if (!m?.[1]) return null
  const base = parseMonto(m[1].replace(/[.,]$/, ""), "COP")
  if (!Number.isFinite(base)) return null
  return m[2] ? base * 1_000_000 : base
}

export function evaluar(dir: string, p: Paquete): { validacion: Validacion; proveedor: Proveedor | null } {
  const m = leerMaestros(dir)
  const s = p.solicitud
  const bloqueos: Bloqueo[] = []
  const confirmaciones: Confirmacion[] = []
  const derivados: Record<string, Derivado> = {}
  const acciones: string[] = []
  const bloquear = (codigo: string, regla: string, detalle: string, accion: string) =>
    bloqueos.push({ codigo, regla, detalle, accion_sugerida: accion })
  const confirmar = (codigo: string, regla: string, detalle: string) => confirmaciones.push({ codigo, regla, detalle })

  // RC1
  const proveedor = buscarProveedor(m, s)
  if (!proveedor) {
    const id = s.proveedor_nit ? `NIT ${normalizarNit(s.proveedor_nit)}` : `nombre "${s.proveedor_nombre}"`
    bloquear("PROVEEDOR_NO_EXISTE", "RC1", `El proveedor (${id}) no existe en el maestro de proveedores.`, "solicitar creación del proveedor en el maestro")
  } else if (!proveedor.activo) {
    bloquear("PROVEEDOR_INACTIVO", "RC1", `El proveedor ${proveedor.nombre} (${proveedor.codigo_sap}) está inactivo.`, "solicitar la reactivación del proveedor en el maestro o elegir otro proveedor")
  } else if (p.cotizacion?.nit && p.cotizacion.nit !== proveedor.nit) {
    confirmar("NIT_COTIZACION_DISTINTO", "RC1", `El NIT de la cotización (${p.cotizacion.nit}) no coincide con el del maestro (${proveedor.nit}).`)
  }

  // RC4 + centro de costo
  const cc = m.centros.find((c) => c.centro_costo === s.centro_costo)
  if (!cc) {
    bloquear("CENTRO_COSTO_INEXISTENTE", "RC4", `El centro de costos ${s.centro_costo} no existe en el maestro.`, "corregir el centro de costos en la solicitud")
  } else if (!cc.subareas.some((x) => normalizarNombre(x) === normalizarNombre(s.subarea))) {
    bloquear("SUBAREA_INVALIDA", "RC4", `La subárea "${s.subarea}" no pertenece a ${cc.centro_costo} (válidas: ${cc.subareas.join(", ")}).`, "corregir la subárea o el centro de costos en la solicitud")
  }

  // RC2 y RC3
  const sugerencia = sugerirCentro(m, p)
  const ap = p.aprobacion
  if (!ap) {
    bloquear("APROBACION_AUSENTE", "RC2", "No hay correo de aprobación en el paquete.", "pedir al solicitante el correo de aprobación del líder")
  } else {
    if (!ap.aprobado) bloquear("APROBACION_SIN_APROBADO", "RC2", `El correo de aprobación de ${ap.de} no contiene la palabra "Aprobado".`, "pedir al líder una respuesta explícita de aprobación")
    const aprobador = cc?.aprobadores.find((a) => a.email.toLowerCase() === ap.de.toLowerCase())
    if (cc && !aprobador) {
      bloquear("APROBADOR_NO_AUTORIZADO", "RC2", `${ap.de} no es aprobador de ${cc.centro_costo} (aprobadores: ${cc.aprobadores.map((a) => a.email).join(", ")}).`, sugerencia ?? `pedir la aprobación a un aprobador de ${cc.centro_costo}`)
    }
    if (cc) {
      const tope = aprobador?.tope ?? Math.max(...cc.aprobadores.map((a) => a.tope))
      if (s.valor_total > tope) {
        const quien = aprobador ? ap.de : `el mayor tope de ${cc.centro_costo}`
        bloquear("MONTO_EXCEDE_TOPE", "RC3", `El valor ${s.moneda} ${miles(s.valor_total)} supera el tope de ${miles(tope)} (${quien}).`, sugerencia ?? "pedir aprobación a un aprobador con tope suficiente")
      }
    }
  }

  // RC10
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > 1) {
    bloquear("TOTAL_INCONSISTENTE", "RC10", `cantidad × valor unitario = ${miles(calculado)} pero valor_total = ${miles(s.valor_total)}.`, "pedir al solicitante corregir cantidad, valor unitario o total")
  }

  if (s.moneda !== "COP" && s.moneda !== "USD") {
    bloquear("MONEDA_NO_SOPORTADA", "RC10", `La moneda ${s.moneda} no es COP ni USD.`, "corregir la moneda en la solicitud")
  }

  // RC5
  if (!p.cotizacion) {
    confirmar("COTIZACION_AUSENTE", "RC5", "No hay cotización en el paquete: se requiere confirmación para crear sin ella.")
  } else {
    const dif = Math.abs(p.cotizacion.total - s.valor_total) / s.valor_total
    if (dif > 0.02) {
      confirmar("COTIZACION_DIFIERE", "RC5", `El total de la cotización (${p.cotizacion.moneda} ${miles(p.cotizacion.total)}) difiere ${(dif * 100).toFixed(1)}% del valor de la solicitud (${s.moneda} ${miles(s.valor_total)}); el máximo permitido es 2%. La OC usará el valor de la solicitud.`)
    }
  }

  // Monto aprobado explícito en el cuerpo
  if (ap) {
    const aprobado = montoAprobadoExplicito(ap.texto)
    const mayor = Math.max(s.valor_total, p.cotizacion?.total ?? 0)
    if (aprobado !== null && mayor > aprobado) {
      confirmar("MONTO_APROBADO_EXPLICITO", "RC3", `La aprobación dice "aprobado por ${miles(aprobado)}", pero el valor a comprar es ${miles(mayor)}${mayor === s.valor_total ? "" : " (según la cotización)"}.`)
    }
  }

  // RC6 / RC7
  if (!s.indicador_iva) {
    if (proveedor) {
      derivados.indicador_iva = { valor: proveedor.indicador_iva_default, fuente: "maestro.proveedores", detalle: `Indicador de IVA tomado del proveedor ${proveedor.nombre}.` }
      confirmar("IVA_DERIVADO", "RC6", `La solicitud no informa indicador de IVA; se derivó ${proveedor.indicador_iva_default} del maestro del proveedor.`)
    } else bloquear("IVA_NO_DERIVABLE", "RC6", "No hay indicador de IVA y no se puede derivar sin proveedor.", "informar el indicador de IVA en la solicitud")
  } else if (!m.iva.some((i) => i.codigo === s.indicador_iva)) {
    bloquear("IVA_INVALIDO", "RC6", `El indicador de IVA ${s.indicador_iva} no existe en el maestro.`, "corregir el indicador de IVA")
  }
  if (!s.condiciones_pago) {
    if (proveedor) {
      derivados.condiciones_pago = { valor: proveedor.condiciones_pago_default, fuente: "maestro.proveedores", detalle: `Condiciones de pago por defecto del proveedor ${proveedor.nombre} (solo informativo).` }
    } else bloquear("PAGO_NO_DERIVABLE", "RC7", "No hay condiciones de pago y no se pueden derivar sin proveedor.", "informar las condiciones de pago")
  } else if (!m.pagos.some((c) => c.codigo === s.condiciones_pago)) {
    bloquear("PAGO_INVALIDO", "RC7", `Las condiciones de pago ${s.condiciones_pago} no existen en el maestro.`, "corregir las condiciones de pago")
  }

  // RC8
  const retroactiva = !!p.factura && dia(p.factura.fecha) < dia(s.fecha_solicitud)
  if (retroactiva && p.factura) {
    confirmar("RETROACTIVA", "RC8", `La factura ${p.factura.numero} (${dia(p.factura.fecha)}) es anterior a la solicitud (${dia(s.fecha_solicitud)}): OC retroactiva, se registra en control.`)
  }

  // RC9
  if (ap && dia(ap.fecha) < dia(s.fecha_solicitud)) {
    confirmar("APROBACION_ANTERIOR", "RC9", `La aprobación (${dia(ap.fecha)}) es anterior a la solicitud (${dia(s.fecha_solicitud)}).`)
  }

  for (const b of bloqueos) if (!acciones.includes(b.accion_sugerida)) acciones.push(b.accion_sugerida)
  return { validacion: { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva, acciones_sugeridas: acciones }, proveedor }
}

// ---------- Evidencia ----------

const encabezados = (a: Aprobacion) => `De: ${a.de}\nPara: ${a.para}\nFecha: ${a.fecha}\nAsunto: ${a.asunto}\n\n${a.texto}\n`

export function sha256(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex")
}

async function escribirPdf(ruta: string, contenido: string, sha: string, fechaIso: string): Promise<void> {
  const pdf = await PDFDocument.create()
  const fechaDoc = new Date(fechaIso)
  pdf.setCreationDate(fechaDoc)
  pdf.setModificationDate(fechaDoc)
  const fuente = await pdf.embedFont(StandardFonts.Helvetica)
  const limpio = `${contenido}\nsha256: ${sha}`.replace(/[^\n\x20-\x7E\u00A0-\u00FF]/g, "?")
  const lineas = limpio.split("\n").flatMap((l) => l.match(/.{1,90}/g) ?? [""])
  let pagina = pdf.addPage()
  let y = pagina.getHeight() - 50
  for (const l of lineas) {
    if (y < 50) {
      pagina = pdf.addPage()
      y = pagina.getHeight() - 50
    }
    pagina.drawText(l, { x: 50, y, size: 10, font: fuente })
    y -= 14
  }
  writeFileSync(ruta, await pdf.save())
}

export async function generarEvidencia(
  dir: string,
  caso: string,
  paquete: Paquete,
): Promise<Resultado<{ ruta: string; ruta_pdf: string; sha256: string }>> {
  const a = paquete.aprobacion
  if (!a) return fallo("No hay correo de aprobación en el paquete: no se puede generar la evidencia.")
  const contenido = encabezados(a)
  const sha = sha256(contenido)
  const carpeta = rutaOut(dir, caso)
  mkdirSync(carpeta, { recursive: true })
  writeFileSync(join(carpeta, "aprobacion.txt"), `${contenido}\nsha256: ${sha}\n`)
  await escribirPdf(join(carpeta, "aprobacion.pdf"), contenido, sha, a.fecha)
  return ok({ ruta: `out/${caso}/aprobacion.txt`, ruta_pdf: `out/${caso}/aprobacion.pdf`, sha256: sha })
}

// ---------- Payload y trazabilidad ----------

export function inferirUnidad(descripcion: string): "UN" | "H" | "MES" {
  const d = sinTildes(descripcion).toLowerCase()
  if (/\bhoras?\b/.test(d)) return "H"
  if (/\bmensual(es)?\b|\bpor mes\b/.test(d)) return "MES"
  return "UN"
}

export type Trazabilidad = {
  caso: string
  solicitud_id: string
  valores: { campo: string; valor: unknown; fuente: string }[]
  excepciones: { codigo: string; detalle: string }[]
  notas: string[]
}

export function construirOrden(
  paquete: Paquete,
  validacion: Validacion,
  proveedor: Proveedor,
  sha: string,
  caso: string,
): { orden: OrdenCompra; trazabilidad: Trazabilidad } {
  const s = paquete.solicitud
  const ap = paquete.aprobacion
  if (!ap) throw new Error("falta la aprobación")
  const ivaDer = validacion.derivados.indicador_iva
  const pagoDer = validacion.derivados.condiciones_pago
  const indicador = s.indicador_iva ?? ivaDer?.valor ?? ""
  const pago = s.condiciones_pago ?? pagoDer?.valor ?? ""
  const truncada = s.descripcion.length > 40
  const descripcion = truncada ? s.descripcion.slice(0, 40).trimEnd() : s.descripcion
  const unidad = inferirUnidad(s.descripcion)

  const excepciones: OrdenCompra["excepciones"] = validacion.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: null }))
  const traza: Trazabilidad = { caso, solicitud_id: s.solicitud_id, valores: [], excepciones: [], notas: [] }
  if (truncada) {
    const detalle = `La descripción tiene ${s.descripcion.length} caracteres y se truncó a 40 (límite SAP).`
    excepciones.push({ codigo: "DESCRIPCION_TRUNCADA", detalle, confirmado_por: null })
  }
  traza.excepciones = excepciones.map((e) => ({ codigo: e.codigo, detalle: e.detalle }))

  const orden = OrdenCompraSchema.parse({
    referencia: { solicitud_id: s.solicitud_id, correo_id: paquete.correo.id, cotizacion_ref: paquete.cotizacion?.referencia ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda: s.moneda,
    condiciones_pago: pago,
    aprobador: { email: ap.de, fecha_aprobacion: ap.fecha, evidencia_sha256: sha },
    posiciones: [
      { numero: 10, descripcion, cantidad: s.cantidad, unidad, precio_unitario: s.valor_unitario, centro_costo: s.centro_costo, subarea: s.subarea, indicador_iva: indicador },
    ],
    excepciones,
  })

  const v = (campo: string, valor: unknown, fuente: string) => traza.valores.push({ campo, valor, fuente })
  v("referencia.solicitud_id", orden.referencia.solicitud_id, "solicitud")
  v("referencia.correo_id", orden.referencia.correo_id, "correo")
  v("referencia.cotizacion_ref", orden.referencia.cotizacion_ref, "cotizacion")
  v("sociedad", "1000", "derivado")
  v("organizacion_compras", "1000", "derivado")
  v("proveedor.codigo_sap", proveedor.codigo_sap, "maestro.proveedores")
  v("proveedor.nit", proveedor.nit, "maestro.proveedores")
  v("proveedor.nombre", proveedor.nombre, "maestro.proveedores")
  v("moneda", orden.moneda, "solicitud")
  v("condiciones_pago", pago, s.condiciones_pago ? "solicitud" : "derivado")
  v("aprobador.email", ap.de, "aprobacion")
  v("aprobador.fecha_aprobacion", ap.fecha, "aprobacion")
  v("aprobador.evidencia_sha256", sha, "derivado")
  v("posiciones[0].numero", 10, "derivado")
  v("posiciones[0].descripcion", descripcion, truncada ? "derivado" : "solicitud")
  v("posiciones[0].cantidad", s.cantidad, "solicitud")
  v("posiciones[0].unidad", unidad, "derivado")
  v("posiciones[0].precio_unitario", s.valor_unitario, "solicitud")
  v("posiciones[0].centro_costo", s.centro_costo, "solicitud")
  v("posiciones[0].subarea", s.subarea, "solicitud")
  v("posiciones[0].indicador_iva", indicador, s.indicador_iva ? "solicitud" : "derivado")
  if (truncada) traza.notas.push(`DESCRIPCION_TRUNCADA: ${traza.excepciones.find((e) => e.codigo === "DESCRIPCION_TRUNCADA")?.detalle ?? ""}`)
  if (ivaDer) traza.notas.push(`indicador_iva derivado: ${ivaDer.detalle}`)
  if (pagoDer) traza.notas.push(`condiciones_pago derivadas: ${pagoDer.detalle}`)
  if (paquete.cotizacion) {
    traza.notas.push("posible doble IVA en SAP; validar si precio_unitario debe ir neto (los precios de la cotización son IVA incluido y el payload lleva el indicador " + indicador + ")")
  }
  return { orden, trazabilidad: traza }
}

export function escribirTrazabilidad(dir: string, caso: string, t: Trazabilidad): string {
  const carpeta = rutaOut(dir, caso)
  mkdirSync(carpeta, { recursive: true })
  writeFileSync(join(carpeta, "trazabilidad.json"), JSON.stringify(t, null, 2))
  return `out/${caso}/trazabilidad.json`
}

// ---------- Control ----------

const csv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

export function registrarControl(
  dir: string,
  fila: { solicitud_id: string; resultado: string; numero_oc: string; retroactiva: boolean; bloqueos: string[]; confirmaciones: string[] },
): void {
  const ruta = join(dir, "out", "control.csv")
  mkdirSync(join(dir, "out"), { recursive: true })
  if (!existsSync(ruta)) appendFileSync(ruta, "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n")
  const campos = [fila.solicitud_id, fila.resultado, fila.numero_oc, String(fila.retroactiva), fila.bloqueos.join("|"), fila.confirmaciones.join("|"), new Date().toISOString()]
  appendFileSync(ruta, campos.map(csv).join(",") + "\n")
}
