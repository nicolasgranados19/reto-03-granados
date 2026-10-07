import { z } from "zod"
import * as tools from "../tools/oc"
import type { DefinicionHerramienta } from "../llm/adapter"

const PREFIJO = "oc"
export type Ctx = { directory: string; sessionId: string }
type Tool = {
  description: string
  args: Record<string, z.ZodType>
  execute: (args: never, ctx: Ctx) => Promise<string>
}

const registro = new Map<string, Tool>()
for (const [nombre, t] of Object.entries(tools as unknown as Record<string, Tool>)) {
  if (t && typeof t.execute === "function") registro.set(`${PREFIJO}_${nombre}`, t)
}

export function definiciones(): DefinicionHerramienta[] {
  return [...registro].map(([nombre, t]) => ({
    nombre,
    descripcion: t.description,
    parametros: z.toJSONSchema(z.object(t.args)) as Record<string, unknown>,
  }))
}

export const nombres = () => [...registro.keys()]

/** Valida y ejecuta una herramienta. Nunca lanza. */
export async function ejecutar(nombre: string, args: unknown, ctx: Ctx): Promise<string> {
  try {
    const t = registro.get(nombre)
    if (!t) return JSON.stringify({ ok: false, error: `La herramienta "${nombre}" no existe. Disponibles: ${nombres().join(", ")}.` })
    const p = z.object(t.args).safeParse(args)
    if (!p.success) {
      const detalle = p.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
      return JSON.stringify({ ok: false, error: `Argumentos inválidos para ${nombre}: ${detalle}` })
    }
    return await t.execute(p.data as never, ctx)
  } catch (e) {
    return JSON.stringify({ ok: false, error: `Error al ejecutar ${nombre}: ${e instanceof Error ? e.message : String(e)}` })
  }
}
