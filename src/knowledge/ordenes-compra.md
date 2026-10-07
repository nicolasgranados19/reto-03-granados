# Conocimiento: preparación y creación de órdenes de compra

## Flujo del proceso

Llega un paquete por caso: correo, solicitud (datos de compra), cotización (texto), aprobación del líder (correo) y, a veces, una factura. El agente lee el paquete, lo valida contra los maestros (proveedores, centros de costo, indicadores de IVA, condiciones de pago), genera la evidencia de aprobación, construye la OC como quedaría en SAP y la crea en el SAP simulado. El agente verifica la aprobación; no la solicita.

## Resultado de la validación

- **Bloqueos**: impiden crear la OC. No se pueden superar con confirmación.
- **Confirmaciones**: permiten crear la OC solo si la analista las confirma explícitamente.
- **Derivados**: valores que el agente completó desde maestros; solo se informan.
- **Retroactiva**: marca que la OC se pidió después de recibir la factura; se mide en el log de control.
- Una OC es **apta** cuando no tiene bloqueos.

## Reglas de control

| Regla | Descripción | Tipo |
|---|---|---|
| RC1 | El proveedor debe existir en el maestro (por NIT; si no hay NIT, por nombre normalizado) y estar activo. | Bloqueo |
| RC2 | Debe existir aprobación, contener la palabra "Aprobado" y venir de un correo listado como aprobador del centro de costo. | Bloqueo |
| RC3 | El valor total no puede superar el tope del aprobador para ese centro de costo. | Bloqueo |
| RC4 | La subárea debe pertenecer al centro de costo. | Bloqueo |
| RC5 | El total de la cotización no puede diferir más de 2 % del valor total de la solicitud. Si difiere, se pide confirmación mostrando ambos valores. Si no hay cotización, también se pide confirmación. | Confirmación |
| RC6 | Si falta el indicador de IVA, se deriva del proveedor y se pide confirmación. | Confirmación y derivado |
| RC7 | Si faltan las condiciones de pago, se derivan del proveedor. Solo se informa. | Derivado |
| RC8 | Si existe factura con fecha anterior a la fecha de la solicitud, la OC es retroactiva: se pide confirmación y se registra en control. | Confirmación |
| RC9 | La fecha de aprobación debe ser igual o posterior a la fecha de la solicitud; si no, se pide confirmación. | Confirmación |
| RC10 | Cantidad por valor unitario debe igualar el valor total (tolerancia de una unidad monetaria). | Bloqueo |

## Creación en SAP simulado

- Solo se crea si el caso es apto y, si hay confirmaciones, el usuario las confirmó.
- Los números de OC son secuenciales desde 4500000001.
- Crear dos veces la misma solicitud devuelve el número existente (idempotencia), no una OC nueva.
- Cada intento (creada, bloqueada, pendiente o idempotente) queda en el log de control `out/control.csv`.
- La descripción de cada posición se limita a 40 caracteres (límite SAP); si se trunca, queda como excepción en el payload.
- Toda la evidencia (aprobacion.txt, aprobacion.pdf con sha256) y la trazabilidad de cada valor se guardan en `out/<caso>/`.

## Estados de un caso

Bloqueado (no se crea, se explica el motivo y la acción sugerida), pendiente de confirmación, creado, idempotente (ya existía).
