export type LlamadaHerramienta = { id: string; nombre: string; argumentos: string }
export type Mensaje = {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  toolCalls?: LlamadaHerramienta[]
  toolCallId?: string
  name?: string
}
export type DefinicionHerramienta = { nombre: string; descripcion: string; parametros: Record<string, unknown> }
export type RespuestaLlm = { texto: string; llamadas: LlamadaHerramienta[]; tokens: { entrada: number; salida: number } }
export interface LlmAdapter {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLlm>
}
