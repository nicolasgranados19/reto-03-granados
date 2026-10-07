import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { limpiarSesiones, obtenerSesion, RAIZ, turno } from "./agent/loop"
import { OpenAICompatible } from "./llm/openai-compatible"

const llm = new OpenAICompatible()
const app = new Hono()

app.get("/api/health", (c) => c.json({ ok: true, provider: llm.proveedor, model: llm.modelo }))

const Cuerpo = z.object({ sessionId: z.string().min(1).max(100), message: z.string().min(1) })
app.post("/api/chat", async (c) => {
  const p = Cuerpo.safeParse(await c.req.json().catch(() => null))
  if (!p.success) return c.json({ error: "Cuerpo inválido: se espera { sessionId, message }." }, 400)
  return c.json(await turno(llm, p.data.sessionId, p.data.message))
})

app.get("/api/sessions/:id", (c) => {
  const s = obtenerSesion(c.req.param("id"))
  return s ? c.json(s) : c.json({ error: "Sesión no encontrada" }, 404)
})

app.post("/api/reset", (c) => {
  limpiarSesiones()
  rmSync(join(RAIZ, "out"), { recursive: true, force: true })
  return c.json({ ok: true })
})

app.use("/*", serveStatic({ root: "./web" }))

const port = Number(process.env.PORT ?? 3000)
Bun.serve({ port, fetch: app.fetch })
console.log(`Servidor en http://localhost:${port} (${llm.proveedor} / ${llm.modelo})`)
