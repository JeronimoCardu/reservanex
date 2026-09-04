# OrderFlow — Arquitectura de IA Conversacional

**Versión:** 2.0
**Fecha:** 2026-06-22
**Audience:** Backend Engineers / AI Integration Engineers

---

## 1. Principios de Diseño

### Por qué NO RAG en MVP

RAG (Retrieval-Augmented Generation) sería el enfoque "default" para un chatbot con información de productos. Pero OrderFlow tiene un dominio estructurado donde RAG introduce problemas que el modelo relacional ya resuelve mejor:

| Problema | Con RAG | Con Tool Calling + SQL |
|---|---|---|
| Disponibilidad de fechas | Semánticamente impreciso ("parece disponible") | Exacto (query a `availability_blocks`) |
| Precio de unidad | Puede hallucinar si embeddings no son recientes | Exacto (campo `units.price`) |
| Atributos de propiedad | Depende de cómo se escribió el texto | Query `attributes @> '{"pileta": true}'` |
| Sincronización de datos | Requiere re-indexar al cambiar datos | Siempre tiempo real |
| Costo de infraestructura | Vector DB adicional (Pinecone, pgvector configurado) | Solo PostgreSQL existente |
| Latencia | Embedding + similarity search + LLM | Una query SQL + LLM |

**Conclusión:** Los datos de propiedades son estructurados, actualizables en tiempo real, y requieren precisión exacta (no aproximación semántica). SQL + Tool Calling es superior para este dominio en MVP.

**RAG sí tiene sentido en el futuro** para documentos libres: reglamentos internos del complejo, FAQs extensas, políticas de cancelación en texto natural. Se puede agregar como herramienta adicional cuando sea necesario.

### Por qué NO prompts gigantes

Un prompt gigante con todas las propiedades del tenant inyectadas directamente:
- Es costoso (tokens = dinero por cada mensaje)
- Llega al límite del contexto con tenants grandes
- La IA tiene dificultad para "encontrar" datos específicos en bloques enormes de texto
- No se actualiza en tiempo real (snapshot al inicio de la conversación)

La solución es **inyección de contexto mínima + tool calling** para datos específicos cuando los necesita.

---

## 2. Visión General de la Arquitectura

```
┌─────────────────────────────────────────────────────────────────────┐
│                      PIPELINE DE PROCESAMIENTO                      │
└─────────────────────────────────────────────────────────────────────┘

Cliente WhatsApp
      │
      ▼ webhook
┌─────────────────────┐
│  Webhook Handler    │  ACK 200 inmediato
│  (Edge Function)    │  → INSERT message_queue
└─────────────────────┘
      │ pg_notify
      ▼
┌─────────────────────┐
│  Message Worker     │  Orquestador principal
│  (Node.js process)  │
└────────┬────────────┘
         │
    ┌────▼─────────────────────────────────────────┐
    │              PIPELINE INTERNO                │
    │                                              │
    │  1. Resolve tenant + contact + conversation  │
    │  2. Insert customer message                  │
    │  3. Build AI context                         │
    │  4. Call AI (Claude)                         │
    │     ├── AI detects intent                   │
    │     ├── AI calls tools (0-3 rounds)          │
    │     └── AI generates final response          │
    │  5. Insert AI message                        │
    │  6. Send via WhatsApp API                    │
    │  7. Update conversation metadata             │
    └──────────────────────────────────────────────┘
         │
    ┌────▼─────────────────────┐
    │  Tool Executor (Node.js) │
    │  Ejecuta tool calls      │
    │  contra PostgreSQL       │
    └──────────────────────────┘
```

---

## 3. Context Injection

La IA recibe un contexto estructurado en cada llamada. El objetivo es dar **suficiente información** para responder sin datos genéricos, pero **sin datos masivos** que aumenten el costo de tokens.

### 3.1 System Prompt Base

El system prompt se construye dinámicamente en el worker, no es un string estático:

```
[tenant_context.system_prompt]

Tu nombre es {assistant_name}.
Trabajas para {tenant_name}.
Eres un asistente de ventas especializado en propiedades de alquiler temporario.

REGLAS OPERATIVAS:
- Responde siempre en el idioma del cliente.
- Si el cliente pregunta por disponibilidad o precios, usa las herramientas disponibles para obtener datos actualizados.
- NO inventes disponibilidades ni precios.
- Si el cliente quiere avanzar con una reserva, solicita: nombre completo, DNI, cantidad de huéspedes, fechas exactas.
- Antes de crear una pre-reserva, verifica disponibilidad con check_availability().
- Si el cliente menciona: {escalation_keywords}, escala inmediatamente con escalate_to_human().
- Si llevas más de {max_turns_before_escalation} intercambios sin resolver la consulta, escala.
- Responde de forma concisa. El canal es WhatsApp: máximo 3-4 párrafos cortos.
```

El `system_prompt` configurable del tenant se inyecta al inicio, permitiendo personalizar el tono, nombre del asistente, políticas propias, etc.

### 3.2 Conversation Context

```typescript
interface AIContext {
  tenant: {
    name: string
    assistant_name: string
    currency: string
    business_hours?: string
  }
  contact: {
    id: string
    name?: string        // null si contacto nuevo
    phone: string
    is_returning: boolean
    reservations_count: number  // cuántas reservas previas tiene
  }
  conversation: {
    id: string
    history: Message[]  // últimos N mensajes (configurable, default 10)
    current_reservation?: {  // si hay una reserva en progreso
      id: string
      unit_name: string
      status: string
      start_date?: string
      end_date?: string
    }
  }
}

interface Message {
  role: 'user' | 'assistant'  // formato OpenAI/Anthropic
  content: string
  created_at: string
}
```

**Límite de historial:** Por defecto `max_context_messages = 10`. Esto limita el costo de tokens. Para conversaciones largas, el worker toma los 10 mensajes más recientes. Si el cliente retoma una conversación de días anteriores, el worker incluye un resumen del estado actual en el system prompt:

```
[Si hay reserva en progreso]:
"El cliente tiene una pre-reserva en progreso para {unit_name}, 
{start_date} al {end_date}, estado: {status}."
```

### 3.3 Por qué NO incluir todas las propiedades en el contexto inicial

Un tenant con 50 propiedades × 500 tokens/propiedad = 25,000 tokens extra en cada mensaje. A $0.003/1K tokens (Claude Sonnet), eso son $0.075 por mensaje solo en propiedades. Con 100 mensajes/día por tenant, son $7.50/día extras por tenant solo en contexto innecesario.

**La IA usa `search_properties()` cuando lo necesita.** Solo paga tokens cuando el cliente realmente pregunta por propiedades.

---

## 4. Herramientas (Tool Calling)

Las herramientas se definen usando el formato de tool use de Claude (Anthropic) o equivalente. El worker las ejecuta localmente contra la base de datos.

### 4.1 search_properties

**Cuándo la usa la IA:** El cliente busca propiedades sin saber cuál quiere ("busco una cabaña para 6 personas con pileta").

```typescript
Tool: search_properties

Input Schema:
{
  capacity?: number          // mínimo de huéspedes necesarios
  min_price?: number         // precio mínimo por noche
  max_price?: number         // precio máximo por noche
  city?: string              // ciudad
  attributes?: object        // ej: { pileta: true, cochera: true, mascotas: true }
  available_from?: string    // ISO date, para filtrar por disponibilidad
  available_to?: string      // ISO date
  limit?: number             // máx resultados (default: 3, máx: 5 para WhatsApp)
}

Output:
{
  results: Array<{
    property_id: string
    property_title: string
    unit_id: string
    unit_name: string
    capacity: number
    price: number
    currency: string
    city: string
    neighborhood: string
    key_attributes: object    // solo atributos más relevantes
    is_available: boolean     // si se proporcionaron fechas
    image_url?: string        // primera imagen si existe
  }>
  total_found: number
}
```

**Implementación SQL:**
```sql
SELECT
  p.id AS property_id,
  p.title AS property_title,
  u.id AS unit_id,
  u.name AS unit_name,
  u.capacity,
  u.price,
  u.currency,
  p.city,
  p.neighborhood,
  p.attributes AS key_attributes,
  NOT EXISTS (
    SELECT 1 FROM availability_blocks ab
    WHERE ab.unit_id = u.id
      AND ab.start_date < $available_to
      AND ab.end_date > $available_from
  ) AS is_available,
  (SELECT image_url FROM property_images pi WHERE pi.property_id = p.id ORDER BY sort_order LIMIT 1) AS image_url
FROM units u
JOIN properties p ON u.property_id = p.id
WHERE p.tenant_id = $tenant_id
  AND p.published = true
  AND p.deleted_at IS NULL
  AND u.active = true
  AND u.deleted_at IS NULL
  AND ($capacity IS NULL OR u.capacity >= $capacity)
  AND ($min_price IS NULL OR u.price >= $min_price)
  AND ($max_price IS NULL OR u.price <= $max_price)
  AND ($city IS NULL OR LOWER(p.city) LIKE LOWER('%' || $city || '%'))
  AND ($attributes IS NULL OR p.attributes @> $attributes::jsonb)
ORDER BY u.price ASC
LIMIT $limit;
```

---

### 4.2 check_availability

**Cuándo la usa la IA:** El cliente pregunta si una unidad específica está disponible en fechas concretas.

```typescript
Tool: check_availability

Input Schema:
{
  unit_id: string           // UUID de la unidad
  start_date: string        // ISO date: "2026-07-10"
  end_date: string          // ISO date: "2026-07-15"
}

Output:
{
  available: boolean
  unit_name: string
  price_per_night: number
  currency: string
  total_nights: number
  estimated_total: number
  conflicting_blocks?: Array<{
    start_date: string
    end_date: string
  }>
  next_available?: {       // si no está disponible, cuándo sí
    from: string
    to: string
  }
}
```

**Nota:** Si `available = false`, la IA devuelve las fechas alternativas más próximas para ayudar al cliente a encontrar opciones.

---

### 4.3 get_property_details

**Cuándo la usa la IA:** El cliente pregunta por detalles específicos de una propiedad/unidad que ya identificó.

```typescript
Tool: get_property_details

Input Schema:
{
  property_id?: string      // obtener detalles de toda la propiedad
  unit_id?: string          // obtener detalles de una unidad específica
}

Output:
{
  property: {
    id: string
    title: string
    description: string
    city: string
    neighborhood: string
    address: string
    google_maps_url: string
    attributes: object       // todos los atributos
    images: string[]         // URLs de imágenes
  }
  units: Array<{
    id: string
    name: string
    capacity: number
    price: number
    currency: string
    images: string[]
  }>
}
```

---

### 4.4 create_pre_reservation

**Cuándo la usa la IA:** El cliente proporcionó todos los datos necesarios y quiere avanzar con la reserva.

**Datos requeridos antes de llamar esta herramienta:**
- Nombre completo del cliente
- DNI (documento)
- Cantidad de huéspedes
- Fechas exactas (start_date, end_date)
- unit_id confirmado

```typescript
Tool: create_pre_reservation

Input Schema:
{
  contact_id: string        // ya identificado en el sistema
  unit_id: string
  start_date: string        // ISO date
  end_date: string          // ISO date
  guests: number
  conversation_id: string
  contact_name: string      // para actualizar en contacts si era desconocido
  contact_dni?: string      // guardar en notes si se proporcionó
}

Output:
{
  success: boolean
  reservation_id?: string
  expires_at?: string       // cuándo expira la pre-reserva (default: 48h)
  total_amount: number
  currency: string
  payment_instructions?: string   // instrucciones de pago del tenant
  error?: 'unit_not_available' | 'dates_invalid' | 'unit_not_found'
}
```

**Lógica interna del tool:**

```
1. Verificar disponibilidad (check_availability internamente)
2. Si no disponible → return { success: false, error: 'unit_not_available' }
3. BEGIN TRANSACTION
4. INSERT reservations (status = 'pre_reserved', expires_at = now() + 48h)
5. INSERT availability_blocks (reason = 'reservation', reservation_id = new_id)
6. UPDATE contacts SET name = $contact_name WHERE id = $contact_id (si tenía nombre vacío)
7. INSERT notes (content = "DNI: {dni}, huéspedes: {guests}") si se proporcionó DNI
8. COMMIT
9. return { success: true, reservation_id, expires_at, total_amount, payment_instructions }
```

**Por qué usar una transacción:** Si el INSERT de availability_blocks falla, la reserva también debe revertirse. Sin transacción, se podría crear una reserva sin bloquear las fechas.

---

### 4.5 escalate_to_human

**Cuándo la usa la IA:**
- El cliente pide hablar con un humano explícitamente
- Se detecta una keyword de escalamiento en `ai_settings.escalation_keywords`
- La conversación supera `max_turns_before_escalation`
- Un tool call falla por error técnico
- El cliente expresa frustración o hace un reclamo

```typescript
Tool: escalate_to_human

Input Schema:
{
  conversation_id: string
  reason: 'user_request' | 'negotiation' | 'complaint' | 'discount' | 'special_case' | 'technical_error' | 'max_turns_reached'
  summary: string           // resumen generado por la IA para el agente humano (máx 200 chars)
  suggested_action?: string // qué debería hacer el humano (ej: "verificar disponibilidad de fechas X-Y")
}

Output:
{
  success: boolean
  assigned_user?: {
    name: string
    response_time: string   // ej: "en horario comercial"
  }
}
```

**Lógica interna:**

```
1. UPDATE conversations SET ai_mode = 'human', status = 'waiting'
2. Identificar usuario asignado (assigned_user_id) o notificar al owner
3. INSERT notifications (type = 'ai_escalation', recipient = assigned_user o owner)
4. INSERT notes (content = "IA escaló: {summary}\nRazón: {reason}\nSugerencia: {suggested_action}")
5. Opcionalmente: INSERT tasks (title = "Atender escalamiento de {contact.name}", due_date = +2h)
6. Return success
```

**Mensaje de la IA al cliente tras escalar:**
```
"Entiendo que necesitas asistencia personalizada. 
He notificado al equipo de {tenant_name} y alguien te 
contactará a la brevedad. Muchas gracias por tu paciencia."
```

---

### 4.6 create_task

**Cuándo la usa la IA:** Después de una conversación que requiere seguimiento posterior (el humano no está disponible ahora).

```typescript
Tool: create_task

Input Schema:
{
  contact_id: string
  title: string                   // tarea clara y accionable
  description?: string
  due_date?: string               // ISO datetime
  reservation_id?: string         // si está relacionada a una reserva
  conversation_id: string
}

Output:
{
  task_id: string
  success: boolean
}
```

---

### 4.7 get_contact_history (herramienta de contexto)

**Cuándo la usa la IA:** Al inicio de una conversación con un contacto que ya tiene historial.

```typescript
Tool: get_contact_history

Input Schema:
{
  contact_id: string
}

Output:
{
  contact: {
    name?: string
    reservations: Array<{
      unit_name: string
      start_date: string
      end_date: string
      status: string
      created_at: string
    }>
    last_conversation_at?: string
    notes_count: number
  }
}
```

---

## 5. Flujo Completo de una Conversación

### Ejemplo: Cliente busca cabaña y hace pre-reserva

```
Cliente: "Hola! busco una cabaña para 4 personas con pileta para el fin de semana del 18-20 de julio"

─── Worker recibe mensaje ───────────────────────────────────────────
1. UPSERT contacts (phone = '+5491122334455') → contact_id = X
2. SELECT conversations WHERE contact_id = X AND status = 'open' → none
3. INSERT conversations (contact_id = X, tenant_id = T, ai_mode = 'auto') → conv_id = C
4. INSERT messages (conversation_id = C, sender_type = 'customer', content = "Hola!...")

─── Build AI Context ────────────────────────────────────────────────
context = {
  tenant: { name: "Los Pinos", assistant_name: "Sofia" },
  contact: { id: X, name: null, is_returning: false },
  conversation: { id: C, history: [{ role: "user", content: "Hola!..." }] }
}

─── Call Claude ─────────────────────────────────────────────────────
Claude detects intent: property_search
Claude calls: search_properties({
  capacity: 4,
  attributes: { pileta: true },
  available_from: "2026-07-18",
  available_to: "2026-07-20",
  limit: 3
})

Tool executor → SQL query → returns:
[
  { unit_id: "U1", unit_name: "Cabaña Roble", capacity: 4, price: 25000, is_available: true },
  { unit_id: "U2", unit_name: "Cabaña Pino", capacity: 5, price: 32000, is_available: false }
]

Claude generates response:
"¡Hola! Soy Sofia de Los Pinos. 😊
Encontré opciones disponibles para el 18-20 de julio:

🏡 *Cabaña Roble* — 4 personas, con pileta
💰 $25.000/noche | Total estimado: $50.000

¿Te gustaría conocer más detalles o avanzar con esta cabaña?"

─── Worker inserta respuesta y envía ────────────────────────────────
5. INSERT messages (conversation_id = C, sender_type = 'ai', content = response)
6. POST WhatsApp API → send message to +5491122334455


─── Segunda vuelta ──────────────────────────────────────────────────
Cliente: "Perfecto! Sí, quiero reservar la Cabaña Roble. Soy María García, DNI 28.500.123, somos 3 adultos y 1 niño"

Claude detects intent: reservation_request
Claude calls: check_availability({ unit_id: "U1", start_date: "2026-07-18", end_date: "2026-07-20" })
→ { available: true, total_nights: 2, estimated_total: 50000, currency: "ARS" }

Claude calls: create_pre_reservation({
  contact_id: X,
  unit_id: "U1",
  start_date: "2026-07-18",
  end_date: "2026-07-20",
  guests: 4,
  conversation_id: C,
  contact_name: "María García",
  contact_dni: "28.500.123"
})
→ { success: true, reservation_id: R1, expires_at: "2026-06-24T15:00:00Z", total_amount: 50000 }

Claude generates response:
"¡Perfecto María! 🎉 Tu pre-reserva está confirmada.

📋 *Resumen:*
- Cabaña Roble | 18-20 julio
- 4 huéspedes
- Total: $50.000 ARS

💳 *Para confirmar tu reserva, realizá el pago a:*
[instrucciones de pago del tenant]

*Tenés 48 horas para completar el pago.* 
Envianos el comprobante por este mismo chat. ¡Cualquier consulta, estamos acá!"
```

---

## 6. Límites y Control de Costos

### 6.1 Límite de rondas de tool calling

Máximo **3 rondas** de tool calling por mensaje del cliente. Si en la tercera ronda la IA todavía quiere llamar herramientas, el worker cancela y escala a humano con `reason = 'technical_error'`.

Esto previene loops (IA llama una herramienta, recibe resultado, llama otra, etc.) y cost blowups.

### 6.2 Budget de tokens

| Componente | Límite |
|---|---|
| System prompt | ~1,000 tokens |
| Conversation history | ~2,000 tokens (10 mensajes × 200 tokens avg) |
| Tool results | ~1,500 tokens (máx, depende de resultados) |
| Respuesta del cliente | ~200 tokens |
| **Total input estimado** | **~4,700 tokens** |
| Output de la IA | ~300 tokens (respuestas WhatsApp son cortas) |

A ~$3 / 1M tokens input (Claude Sonnet 4.6), cada intercambio cuesta ~$0.015. Con 50 mensajes/día por tenant, son $0.75/día/tenant.

### 6.3 Logging de uso de tokens

El worker registra el uso de tokens en cada llamada:

```typescript
// Después de cada llamada a la IA
await db.query(`
  INSERT INTO ai_usage_log (tenant_id, conversation_id, input_tokens, output_tokens, model, created_at)
  VALUES ($1, $2, $3, $4, $5, now())
`, [tenantId, conversationId, response.usage.input_tokens, response.usage.output_tokens, model])
```

**Nueva tabla** (no en `07-database-v2.md` por ser opcional en MVP, pero recomendada):

```
ai_usage_log
──────────────────────────────────────────────────────
id               BIGSERIAL PRIMARY KEY
tenant_id        UUID NOT NULL REFERENCES tenants(id)
conversation_id  UUID REFERENCES conversations(id)
model            TEXT NOT NULL
input_tokens     INT NOT NULL
output_tokens    INT NOT NULL
created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
```

---

## 7. Manejo de Errores

### 7.1 Matriz de errores y acciones

| Error | Acción | Notificación |
|---|---|---|
| Timeout de IA (>30s) | Retry hasta 3 veces con backoff 2s, 4s, 8s | Si falla 3 veces: escalar a humano |
| Rate limit de IA (429) | Retry con backoff exponencial | Después de 5 min sin recuperar: notificar admin |
| Tool executor falla (DB error) | Log + escalar a humano | Notificar admin por email |
| WhatsApp API falla (envío) | Retry 3 veces. Si falla: log + tarea manual | Notificar admin |
| Webhook payload inválido | Log + descartar silenciosamente | Ninguna |
| Webhook duplicado | `ON CONFLICT DO NOTHING` en messages | Ninguna |
| pre_reservation conflict | Tool retorna `error: 'unit_not_available'` | IA informa alternativas al cliente |

### 7.2 Fallback message

Si todo falla y la IA no puede responder, el worker envía un mensaje de fallback pre-configurado:

```
"Hola! En este momento estamos experimentando dificultades técnicas. 
Un miembro de nuestro equipo te contactará a la brevedad. 
Disculpá las molestias."
```

Y escala automáticamente a humano.

---

## 8. Detección de Escalamiento

El worker evalúa escalamiento **antes** de llamar a la IA en los siguientes casos (para no gastar tokens en algo que ya sabemos que debe escalar):

```typescript
function shouldEscalate(message: string, context: AIContext, settings: AISettings): EscalationReason | null {
  // 1. Keywords explícitas (verificación de strings, no IA)
  const lowerMsg = message.toLowerCase()
  for (const keyword of settings.escalation_keywords) {
    if (lowerMsg.includes(keyword.toLowerCase())) {
      return 'user_request'
    }
  }

  // 2. Límite de turnos
  const turnCount = context.conversation.history.length / 2  // mensajes / 2 = turnos
  if (turnCount >= settings.max_turns_before_escalation) {
    return 'max_turns_reached'
  }

  // 3. Frases de pedido de humano (heurística rápida)
  const humanPhrases = ['hablar con alguien', 'quiero hablar con', 'un humano', 'una persona', 'atienda un']
  if (humanPhrases.some(phrase => lowerMsg.includes(phrase))) {
    return 'user_request'
  }

  return null  // continuar con IA
}
```

Si `shouldEscalate()` retorna un motivo, el worker llama a `escalate_to_human()` directamente sin pasar por la IA. La respuesta al cliente viene de una plantilla, no del modelo.

---

## 9. Modo Humano

Cuando `conversations.ai_mode = 'human'`:

1. El worker **no llama a la IA** cuando llega un mensaje del cliente
2. Inserta el mensaje del cliente en `messages`
3. Notifica al `assigned_user_id` (o al owner si no hay asignado)
4. El recepcionista responde desde el dashboard
5. El worker envía el mensaje del recepcionista via WhatsApp API
6. El recepcionista puede volver a activar la IA (`conversations.ai_mode = 'auto'`) desde el dashboard

**El recepcionista puede ver el historial completo** de la conversación, incluyendo el resumen que generó la IA al escalar.

---

## 10. Primer mensaje con contexto de propiedad (Flujo Web)

Cuando el cliente llega desde el sitio web haciendo clic en "Consultar por WhatsApp", el primer mensaje tiene un patrón especial:

```
Hola! Consulto por Complejo Los Pinos - Cabaña 1 [property_id:uuid][unit_id:uuid][source:website]
```

El worker detecta este patrón en el primer mensaje:

```typescript
function parseWebsiteContext(message: string): WebsiteContext | null {
  const propertyMatch = message.match(/\[property_id:([a-f0-9-]+)\]/)
  const unitMatch = message.match(/\[unit_id:([a-f0-9-]+)\]/)
  const sourceMatch = message.match(/\[source:(\w+)\]/)

  if (!propertyMatch) return null

  return {
    property_id: propertyMatch[1],
    unit_id: unitMatch?.[1] ?? null,
    source: sourceMatch?.[1] ?? 'website'
  }
}
```

Si detecta contexto de website:
1. Setea `conversations.source = 'website'` (campo a agregar)
2. Llama `get_property_details({ unit_id })` y lo inyecta en el system prompt como "El cliente consulta por: {unit_details}"
3. La IA ya tiene el contexto de la propiedad específica desde el primer mensaje, sin buscar

---

## 11. Límites del MVP (IA)

No implementar en MVP:

| Feature | Motivo de exclusión |
|---|---|
| Análisis de sentimiento | Complejidad + costo extra; las keywords de escalamiento son suficientes |
| RAG / vector search | No necesario con datos estructurados |
| IA de voz | Excluido del MVP en 02-mvp.md |
| Multi-modelo por tenant | Un modelo es suficiente; agregar complejidad de routing no aporta en MVP |
| Fine-tuning del modelo | No hay suficientes datos aún; los prompts resuelven el caso |
| Sugerencias de respuesta para humanos | Post-MVP; requiere UI adicional |
| Análisis automático de conversaciones | Post-MVP; requiere pipeline de analytics separado |
| Memoria a largo plazo (cross-conversation) | `get_contact_history()` es suficiente para MVP |
