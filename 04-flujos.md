# OrderFlow - Flujos de Negocio

# Flujo 1 - Consulta desde la Web

Cliente visita la web pública.

```text
Web
↓
Listado de propiedades
↓
Detalle de propiedad
↓
Botón Consultar por WhatsApp
↓
WhatsApp
↓
IA
```

Al presionar el botón se envía información estructurada:

```json
{
  "property_id": "...",
  "unit_id": "...",
  "tenant_id": "...",
  "source": "website"
}
```

La IA ya conoce qué propiedad está consultando el cliente.

---

# Flujo 2 - Consulta Directa por WhatsApp

Cliente escribe directamente al número de WhatsApp.

```text
Cliente
↓
WhatsApp
↓
IA
↓
Identifica intención
```

Posibles intenciones:

* Consulta disponibilidad
* Consulta precio
* Consulta características
* Solicitud de reserva
* Negociación
* Hablar con humano

---

# Flujo 3 - Recomendación de Propiedades

Cliente aún no eligió una propiedad.

Ejemplo:

```text
Busco una cabaña para 6 personas
con pileta y cochera.
```

La IA consulta la base de datos.

```text
Cliente
↓
IA
↓
Búsqueda
↓
Resultados
↓
Recomendación
```

La IA devuelve propiedades compatibles.

---

# Flujo 4 - Consulta de Disponibilidad

Cliente pregunta fechas.

```text
Cliente
↓
IA
↓
Consulta calendario
↓
Respuesta
```

Ejemplo:

```text
¿Está disponible del 10 al 15?
```

La IA responde utilizando datos reales.

---

# Flujo 5 - Pre Reserva

Cliente decide avanzar.

```text
Cliente
↓
IA
↓
Solicita datos
↓
Nombre
DNI
Teléfono
Fechas
Cantidad de huéspedes
↓
Pre Reserva
```

Estado generado:

```text
PRE_RESERVED
```

Las fechas quedan bloqueadas temporalmente.

---

# Flujo 6 - Confirmación de Reserva

Cliente recibe instrucciones de pago.

```text
Cliente
↓
Envía comprobante
↓
Recepcionista
↓
Valida pago
↓
Confirma reserva
```

Estado:

```text
CONFIRMED
```

Las fechas quedan bloqueadas definitivamente.

---

# Flujo 7 - Cancelación

Cliente cancela.

```text
Cliente
↓
Recepcionista
↓
Cancelar reserva
↓
Liberar fechas
```

Estado:

```text
CANCELLED
```

---

# Flujo 8 - Escalamiento Humano

IA detecta situación que requiere intervención.

Ejemplos:

* Negociación
* Reclamo
* Descuento
* Caso especial

```text
IA
↓
Escalamiento
↓
Notificación
↓
Recepcionista
↓
Toma control
```

La conversación pasa a modo humano.

---

# Flujo 9 - Creación de Cliente por Vendedor

```text
Vendedor
↓
Formulario
↓
Nuevo Tenant
↓
Configuración inicial
↓
Invitación al dueño
```

Se crea:

* Tenant
* Dueño
* Subdominio
* Configuración inicial

---

# Flujo 10 - Publicación de Propiedad

```text
Dueño o Recepcionista
↓
Crear Propiedad
↓
Subir imágenes
↓
Configurar atributos
↓
Publicar
```

La propiedad aparece automáticamente en la web.

---

# Flujo 11 - Gestión de Tareas

```text
Recepcionista
↓
Crear tarea
↓
Asignar usuario
↓
Fecha límite
↓
Completar
```

Ejemplos:

* Llamar cliente
* Enviar contrato
* Verificar pago

---

# Flujo 12 - Gestión de Notificaciones

Eventos:

* Nueva conversación
* Nueva reserva
* Escalamiento IA
* Reserva confirmada
* Reserva cancelada

Destinos:

* WhatsApp
* Email

Configurables por tenant.
