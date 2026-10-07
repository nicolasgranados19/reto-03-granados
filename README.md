# reto-03-granados - Agente de Ordenes de Compra

Agente que lee un paquete de solicitud (correo, aprobacion, cotizacion, factura), valida RC1-RC10, genera evidencia de aprobacion y crea la OC en un SAP simulado, con confirmacion humana impuesta por diseno.

Link de prueba: https://reto-03-granados.onrender.com/

## Levantar en local

```bash
bun install
cp .env.example .env   # completar variables (ver abajo)
bun run dev            # http://localhost:3000
```

Con Docker: `docker build -t reto03 . && docker run --env-file .env -p 3000:3000 reto03`

## Variables de entorno

| Variable | Descripcion |
|---|---|
| LLM_PROVIDER | Nombre del proveedor (ej. groq) |
| LLM_BASE_URL | Endpoint OpenAI-compatible |
| LLM_API_KEY | Clave (solo backend, nunca en el repo) |
| LLM_MODEL | Modelo a usar |
| LLM_TIMEOUT_MS | Timeout al LLM (30000) |
| MAX_ITERATIONS | Tope de iteraciones por turno (25) |
| MAX_TOKENS_SESSION | Tope de tokens por sesion (200000) |
| PORT | Puerto (3000) |

## Demo sin modelo

```bash
bun run demo
```

Borra `out/`, llama las herramientas directamente con fecha fija e imprime una tabla por caso.

## Tests

```bash
bun test
bunx tsc --noEmit
```

## API

| Metodo | Ruta | Descripcion |
|---|---|---|
| POST | /api/chat | `{ sessionId, message }` -> `{ reply, toolCalls, needsConfirmation }` |
| GET | /api/sessions/:id | Historial de la sesion |
| GET | /api/health | `{ ok, provider, model }` (nunca la clave) |
| POST | /api/reset | Borra `out/` |
