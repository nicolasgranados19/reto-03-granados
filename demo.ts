import { rmSync, readFileSync } from "node:fs"
import { join } from "node:path"
import * as oc from "./src/tools/oc"

const directory = import.meta.dir
const ctx = { directory, sessionId: "demo" }
type Json = Record<string, any> // salida JSON de las herramientas (solo en la demo)

async function llamar(tool: { execute(a: never, c: typeof ctx): Promise<string> }, args: Record<string, unknown>): Promise<Json> {
  return JSON.parse(await tool.execute(args as never, ctx)) as Json
}

const lista = (xs: { codigo: string }[] | undefined) => (xs && xs.length ? xs.map((x) => x.codigo).join(", ") : "-")
const detalles: string[] = []
const filas: string[][] = [["caso", "apta", "bloqueos", "confirmaciones", "retroactiva", "resultado"]]

async function procesar(caso: string, confirmado = false, etiqueta = caso): Promise<void> {
  const paquete = await llamar(oc.leer_paquete, { caso })
  if (!paquete.ok) return void filas.push([etiqueta, "-", "-", "-", "-", `ERROR: ${paquete.error}`])
  const v = (await llamar(oc.validar, { caso })).data as Json
  if (v.apta) {
    await llamar(oc.generar_evidencia, { caso })
    await llamar(oc.construir_payload, { caso })
  }
  if (!detalles.some((x) => x.startsWith(`[${caso}]`))) {
    for (const b of v.bloqueos as Json[]) detalles.push(`[${caso}] BLOQUEO ${b.regla} ${b.codigo}: ${b.detalle} Acción: ${b.accion_sugerida}`)
    for (const x of v.confirmaciones as Json[]) detalles.push(`[${caso}] CONFIRMAR ${x.regla} ${x.codigo}: ${x.detalle}`)
    for (const [k, x] of Object.entries(v.derivados as Record<string, Json>)) detalles.push(`[${caso}] DERIVADO ${k}=${x.valor} (${x.fuente})`)
  }
  const c = await llamar(oc.crear, { caso, confirmado })
  const res = c.ok ? `OC ${c.data.numero_oc}${c.data.idempotente ? " (idempotente)" : ""}` : String(c.error)
  filas.push([etiqueta, String(v.apta), lista(v.bloqueos), lista(v.confirmaciones), String(v.retroactiva), res])
}

rmSync(join(directory, "out"), { recursive: true, force: true })
console.log("=== Demo R3: órdenes de compra SAP (sin modelo) ===\n")
await procesar("sol-001")
await procesar("sol-001", false, "sol-001 (2a vez)")
await procesar("sol-002")
await procesar("sol-003")
await procesar("sol-004", false, "sol-004 (sin confirmar)")
await procesar("sol-004", true, "sol-004 (confirmado)")
await procesar("sol-005", false, "sol-005 (sin confirmar)")
await procesar("sol-005", true, "sol-005 (confirmado)")
await procesar("sol-006", false, "sol-006 (sin confirmar)")

const ancho = filas[0]!.map((_, i) => Math.max(...filas.map((f) => (f[i] ?? "").length)))
for (const [n, f] of filas.entries()) {
  console.log(f.map((c, i) => c.padEnd(ancho[i] ?? 0)).join(" | "))
  if (n === 0) console.log(ancho.map((a) => "-".repeat(a)).join("-+-"))
}
console.log("\n--- Detalle ---")
for (const x of detalles) console.log(x)
console.log("\n--- out/control.csv ---")
console.log(readFileSync(join(directory, "out", "control.csv"), "utf8").trim())
console.log("\n--- trazabilidad sol-001 (notas) ---")
const tr = JSON.parse(readFileSync(join(directory, "out", "sol-001", "trazabilidad.json"), "utf8")) as { notas: string[] }
for (const n of tr.notas) console.log("- " + n)
