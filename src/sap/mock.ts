import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { OrdenCompra, SapAdapter } from "./adapter"

type ProveedorMaestro = { codigo_sap: string; nit: string; activo: boolean }
type RegistroOrden = { numero_oc: string; fecha: string; solicitud_id: string; orden: OrdenCompra }

const PRIMER_NUMERO = 4500000001

/** SAP simulado: lee maestros de fixtures/ y escribe órdenes en out/sap/ordenes.jsonl. */
export class SapMock implements SapAdapter {
  private readonly archivo: string

  constructor(private readonly directory: string) {
    this.archivo = join(directory, "out", "sap", "ordenes.jsonl")
  }

  async consultarProveedor(nit: string) {
    const ruta = join(this.directory, "fixtures", "reto-03", "maestros", "proveedores.json")
    const lista = JSON.parse(readFileSync(ruta, "utf8")) as ProveedorMaestro[]
    const p = lista.find((x) => x.nit === nit)
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async crearOrden(orden: OrdenCompra) {
    mkdirSync(join(this.directory, "out", "sap"), { recursive: true })
    const numero_oc = String(PRIMER_NUMERO + this.leer().length)
    const fecha = new Date().toISOString()
    const reg: RegistroOrden = { numero_oc, fecha, solicitud_id: orden.referencia.solicitud_id, orden }
    appendFileSync(this.archivo, JSON.stringify(reg) + "\n")
    return { numero_oc, fecha }
  }

  async buscarOrdenPorReferencia(solicitud_id: string) {
    const r = this.leer().find((x) => x.solicitud_id === solicitud_id)
    return r ? { numero_oc: r.numero_oc } : null
  }

  private leer(): RegistroOrden[] {
    if (!existsSync(this.archivo)) return []
    return readFileSync(this.archivo, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as RegistroOrden)
  }
}
