# SOLUCION - Reto 03: Agente de Ordenes de Compra

## 1. Problema en una frase

El analista de compras arma a mano cada OC en SAP cruzando correo, aprobacion, cotizacion y maestros; es lento, propenso a errores y deja pasar OC sin aprobacion valida o retroactivas. Le duele al analista de compras, al aprobador y a control interno/auditoria.

## 2. Arquitectura

```
 Navegador (web/index.html, JS plano)
        |  POST /api/chat
        v
 Hono (src/server.ts) --> Loop del agente (src/agent/loop.ts) --> LlmAdapter
        |                        |                               (openai-compatible: Groq/Gemini)
        |                        v
        |                 Registry (zod, nunca lanza)
        |                        v
        |   Tools src/tools/oc.ts: leer_paquete | validar | generar_evidencia | construir_payload | crear
        |                        v
        |        src/lib/oc-core.ts --> fixtures/ (solo lectura) + out/ (evidencia, sap/, control.csv, log.jsonl, sessions/)
        |                        v
        +--------------- SapAdapter (src/sap/mock.ts sobre out/sap/)
```

- Prompt (comportamiento): `agent/prompt.md`.
- Conocimiento del proceso: `src/knowledge/ordenes-compra.md`.
- Ejecucion y reglas de negocio: solo en las tools (`src/tools/oc.ts`, `src/lib/oc-core.ts`).

## 3. Ciclo del agente

Bucle modelo -> herramientas -> modelo, con tope `MAX_ITERATIONS` (25); al alcanzarlo responde con lo que tiene y lo que falta. Tope de tokens por sesion `MAX_TOKENS_SESSION` (200000). La confirmacion humana se impone en el loop: si el modelo llama una herramienta con `confirmado: true`, solo se permite cuando el ultimo mensaje del usuario coincide con una regex de afirmacion (si, confirmo, procede, adelante, ok...); si no, se fuerza `confirmado: false` y se registra. `needsConfirmation` se activa cuando una tool devuelve confirmaciones pendientes o un error de "requiere confirmacion". Cada llamada se guarda en la sesion (`out/sessions/<id>.json`) y en `out/log.jsonl`. Timeouts y errores del LLM se convierten en un mensaje claro; la sesion no muere.

## 4. Eleccion del modelo

Proveedor Groq (endpoint OpenAI-compatible) con un modelo con tool calling del free tier; Gemini como alternativa cambiando solo variables de entorno. Razon: latencia baja, costo cero en la demo y SDK `openai` estandar.

Costo estimado por caso (precios a verificar): un caso usa aprox. 5-8 llamadas a tools, 15-25k tokens de entrada acumulados y 1-2k de salida. En free tier = USD 0. En un plan pago, con precios a verificar de aprox. USD 0.1-0.6 por millon de tokens de entrada, serian del orden de USD 0.002-0.015 por caso.

## 5. Matriz de controles

| RC | Implementacion | Tipo |
|---|---|---|
| RC1 | Busca proveedor por NIT (o nombre normalizado) en proveedores.json y exige `activo` | Bloqueo |
| RC2 | Aprobacion existente, contiene "Aprobado" y correo listado como aprobador del centro de costo | Bloqueo |
| RC3 | `valor_total` <= tope del aprobador para el centro; si el aprobador no esta listado se usa el mayor tope del CC | Bloqueo |
| RC4 | `subarea` pertenece al `centro_costo` | Bloqueo |
| RC5 | Diferencia cotizacion vs valor_total <= 2 %; si excede o falta cotizacion, confirmacion con ambos valores | Confirmacion |
| RC6 | `indicador_iva` ausente se deriva del proveedor y se confirma | Confirmacion + derivado |
| RC7 | `condiciones_pago` ausente se deriva del proveedor, solo informa | Derivado |
| RC8 | Factura con fecha < fecha_solicitud marca `retroactiva = true`, confirmacion y registro en control | Confirmacion |
| RC9 | Fecha de aprobacion >= fecha_solicitud, si no confirmacion | Confirmacion |
| RC10 | cantidad x valor_unitario = valor_total (+/- 1) | Bloqueo |

Cual fue la mas dificil: RC3 junto con la fuente del monto. El PRD no dice contra que monto comparar cuando difieren valor_total y cotizacion, ni que tope usar si el aprobador no esta listado (RC2 ya bloquea, pero RC3 debe seguir siendo evaluable); ver Supuestos. RC8 fue la segunda por su carga de proceso (ver seccion 7).

## 6. Diseno del adaptador SAP real

Opcion elegida: OData `API_PURCHASEORDER_PROCESS_SRV` expuesto a traves de SAP Integration Suite (o API Management), no RFC/BAPI directa. Razon: con viabilidad no confirmada, OData sobre HTTPS no exige abrir RFC ni librerias nativas, es facil de mockear, y Integration Suite aporta autenticacion, trazas y reintentos. `BAPI_PO_CREATE1` se descarta por requerir conectividad RFC y el SAP NW RFC SDK.

Mapeo del payload 7.4:
- `sociedad` -> `CompanyCode`; `organizacion_compras` -> `PurchasingOrganization`; `proveedor.codigo_sap` -> `Supplier`; `moneda` -> `DocumentCurrency`; `condiciones_pago` -> `PaymentTerms`.
- `posiciones[]` -> `to_PurchaseOrderItem` (`PurchaseOrderItem` = numero, `PurchaseOrderItemText` = descripcion <= 40, `OrderQuantity`, `PurchaseOrderQuantityUnit` = unidad, `NetPriceAmount` = precio_unitario, `TaxCode` = indicador_iva) y `to_AccountAssignment` (`CostCenter`; la subarea a un campo de asignacion segun la configuracion).
- `referencia.solicitud_id` -> campo de referencia de cabecera; `aprobador` y `evidencia_sha256` se guardan como nota de cabecera o adjunto.

Autenticacion: OAuth2 client credentials (o usuario tecnico en red interna) contra el gateway; credenciales en el gestor de secretos o variables del backend, nunca en el agente, el prompt ni el repo. El modelo no ve credenciales: solo la tool `crear` usa el adaptador.

Idempotencia: antes de crear, `buscarOrdenPorReferencia(solicitud_id)`; si existe, devuelve esa OC (reintento seguro). Ante error parcial (timeout tras crear, o 5xx con OC posiblemente creada) no se reintenta a ciegas: se consulta por referencia; si existe se adopta, si no se reintenta una vez con backoff y, si persiste, se marca `pendiente_revision` y se escala al analista con el payload guardado.

Plan B: si SAP no es viable, el agente igual valida y genera por solicitud un archivo de carga masiva (CSV/Excel para carga en ME21N o LSMW) y la evidencia con hash, listos para cargar o pegar; el analista solo carga y confirma, ahorrando lectura, cruces y validaciones.

## 7. Lectura del proceso: OC retroactivas

Para la direccion: una OC retroactiva significa que el bien o servicio ya se facturo antes de que existiera la solicitud formal. El control preventivo de aprobacion no ocurrio; se esta aprobando un hecho consumado, y la compra pudo exceder topes, usar un proveedor no homologado o duplicarse sin que nadie lo notara. El agente no las bloquea (la operacion ya sucedio y hay que regularizarla) pero las detecta siempre, exige confirmacion explicita del analista, las marca `retroactiva = true` y deja traza en `control.csv` y en el payload como excepcion, para que auditoria pueda medirlas.

Lo importante es el patron: que centros de costo, proveedores y aprobadores concentran el fenomeno. Eso es senal de un problema de proceso, no de digitacion: se compra primero y se regulariza despues porque el flujo formal es lento o porque hay urgencias sin via rapida.

Cambio de proceso propuesto: (1) politica "sin OC no se paga": no se paga factura sin OC previa, salvo excepcion documentada; (2) via expedita de aprobacion (menos de 24 h) para urgencias, con tope bajo, para que no haga falta saltarse el control; (3) indicador mensual de OC retroactivas por centro de costo presentado a la direccion, con meta y responsable; (4) aprobacion de retroactivas por un nivel superior al tope normal. El agente automatiza lo mecanico, pero reducir las retroactivas exige cambiar el incentivo, no la herramienta.

## 8. Decisiones y trade-offs

1. **Front HTML plano sin build** (descartado React/Next.js): menos piezas y arranque inmediato; se pierde estructura de componentes, aceptable para un chat.
2. **Confirmacion impuesta en el loop con regex sobre el ultimo mensaje del usuario** (descartado confiar en el prompt): el modelo no puede autoconfirmar; la regex es simple y puede dar falsos negativos, que solo obligan a confirmar de nuevo.
3. **Tools releen desde disco e ignoran valores del modelo** (descartado pasar el paquete entre tools): evita alucinaciones y manipulacion, a costa de mas lecturas de archivo.
4. **Adaptador SAP detras de interfaz con mock en `out/sap/`** (descartado llamar directo): permite cambiar a OData sin tocar las tools.
5. **SDK `openai` contra endpoint compatible** (descartado Vercel AI SDK): una dependencia menos, control total del loop y cambio de proveedor solo por variables de entorno.

## 9. Supuestos

- La fecha "de hoy" es un parametro con default; la demo usa fecha fija. Fechas y zonas horarias en -05:00 (Colombia).
- Las tools releen el paquete desde disco e ignoran paquete y derivados enviados por el modelo.
- `crear` rechaza un payload alterado respecto al que construye la logica.
- `MONTO_APROBADO_EXPLICITO` se compara contra el mayor entre `valor_total` y la cotizacion.
- RC3 con aprobador no listado usa el mayor tope del centro de costo.
- Controles extra: proveedor inactivo, moneda, codigos de IVA y de pago validos, NIT de la cotizacion distinto al del proveedor.
- Solo `crear` escribe `control.csv`; un reintento agrega una fila con estado "idempotente".
- `confirmado_por` se registra como "analista (chat)".
- Fuentes de trazabilidad extra: correo y aprobacion.
- Adjuntos ausentes se representan como `null` mas una lista `faltantes`.
- Sin base de datos ni ejecucion de shell; los fixtures no se modifican.

## 10. Cobertura

| HU | Estado | Falta para produccion |
|---|---|---|
| HU-1 Leer el paquete | Hecho | Lectura de correo/PDF reales (hoy fixtures) |
| HU-2 Validar controles | Hecho (RC1-RC10 + extras) | Maestros reales desde SAP |
| HU-3 Construir payload | Hecho | Mapeo OData real y catalogo de codigos |
| HU-4 Evidencia de aprobacion | Hecho | Almacenamiento inmutable |
| HU-5 Crear OC (SAP simulado) | Hecho | Adaptador SAP real (solo diseno) |
| HU-6 Manejo de errores | Hecho | Observabilidad y alertas |
| Bonus `modulo/` | No hecho (recorte por tiempo) | Implementar `scripts/build-modulo.ts` y su test |

## 11. Uso de IA

- Claude en claude.ai: analisis del PRD y plan de trabajo.
- Claude Code como orquestador, con subagentes por reto, para generar codigo, tests y documentacion.
- Descartado: Vercel AI SDK (dependencia extra y menos control del loop), Next.js (build step innecesario para un chat) y hosting en Vercel (se prefirio un contenedor Docker portable).
- Toda salida se verifico corriendo `tsc`, `bun test` y la demo.

## 12. Riesgos

| Riesgo | Mitigacion |
|---|---|
| 429 / cuota del modelo gratuito de Groq (tokens por minuto) | Mensaje claro en el chat sin matar la sesion; reintento con backoff; topes de tokens e iteraciones; prompt y conocimiento compactos; cambiar de modelo o proveedor por variables de entorno o pasar a plan pago |
| Conexion SAP no viable | Plan B de la seccion 6 (archivo de carga masiva) |
| Modelo omite o inventa valores | Tools como unica fuente de valores; releen desde disco; `crear` rechaza payload alterado |
| Autoconfirmacion del modelo | Confirmacion impuesta en el loop |
| Fuga de clave | Solo variables de entorno; nunca en front, logs ni API |
| Reglas de negocio ambiguas (topes, montos) | Supuestos documentados; validar con control interno |
| Estado local en disco/memoria | Persistir sesiones y control en almacenamiento compartido en produccion |
