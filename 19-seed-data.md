# OrderFlow — Seed Data Specification v1.0

**Versión:** 1.0  
**Fecha:** 2026-06-22  
**Propósito:** Dataset inicial para validar todos los flujos del MVP desde el primer día de desarrollo  
**Formato:** Especificación de datos (NO SQL). El SQL de seed se genera como archivo separado.  

---

## Objetivo del Dataset

Este dataset debe permitir testear:

1. Login con cada rol y verificar JWT claims correctos
2. Workspace scoping: Recepcionista Norte ve solo datos de Zona Norte
3. Workspace scoping: Recepcionista Sur ve solo datos de Zona Sur
4. Recepcionista General ve todo (sin asignaciones)
5. Owner ve todo sin restricción
6. Super Admin puede impersonar al tenant
7. Pipeline AI: mensaje entrante → tool calling → respuesta
8. Flujo de reserva: inquiry → pre_reserved → confirmed → cancelled
9. Disponibilidad y bloqueo de fechas (doble booking debe fallar)
10. Dashboard con conversaciones, reservas, tareas y notas activas

---

## 1. Platform Users

### Super Admin

| Campo | Valor |
|---|---|
| **Nombre** | Carlos Méndez |
| **Email** | carlos.mendez@orderflow.app |
| **Password** | `Orderflow2026!` |
| **Rol** | super_admin |
| **Estado** | active |

### Vendedor (Seller)

| Campo | Valor |
|---|---|
| **Nombre** | Laura Pérez |
| **Email** | laura.perez@orderflow.app |
| **Password** | `Orderflow2026!` |
| **Rol** | seller |
| **Estado** | active |
| **Tenant asignado** | Demo Inmobiliaria (ver abajo) |
| **Comisión** | 10.00% |

---

## 2. Tenant Demo

### Datos del Tenant

| Campo | Valor |
|---|---|
| **Nombre** | Demo Inmobiliaria |
| **Slug** | `demo` |
| **Subdominio** | `demo.orderflow.app` |
| **Estado** | active |
| **Plan** | pro |
| **Max propiedades** | 50 |
| **Max usuarios** | 20 |
| **Color primario** | `#2563EB` (azul) |
| **Color secundario** | `#1E40AF` |

### Site Config

```json
{
  "template": "modern",
  "hero_title": "Tu próxima propiedad te espera",
  "hero_subtitle": "Alquileres temporarios y propiedades para todos los destinos",
  "about_text": "Demo Inmobiliaria es una agencia especializada en alquileres temporarios con más de 10 años de experiencia.",
  "seo_title": "Demo Inmobiliaria | Alquileres Temporarios",
  "seo_description": "Encontrá tu próximo alquiler con Demo Inmobiliaria. Cabañas, departamentos y casas en las mejores zonas.",
  "font": "inter",
  "show_prices": true,
  "contact_email": "info@demoinmobiliaria.com"
}
```

---

## 3. Workspaces

### Workspace 1 — General

| Campo | Valor |
|---|---|
| **Nombre** | General |
| **Tipo** | `general` |
| **Descripción** | Organización completa (auto-creado en onboarding) |
| **Activo** | true |

### Workspace 2 — Zona Norte

| Campo | Valor |
|---|---|
| **Nombre** | Zona Norte |
| **Tipo** | `zone` |
| **Ciudad** | San Carlos de Bariloche |
| **Descripción** | Propiedades y operaciones en la zona norte de la región |
| **Activo** | true |

### Workspace 3 — Zona Sur

| Campo | Valor |
|---|---|
| **Nombre** | Zona Sur |
| **Tipo** | `zone` |
| **Ciudad** | Villa La Angostura |
| **Descripción** | Propiedades y operaciones en la zona sur de la región |
| **Activo** | true |

---

## 4. Usuarios del Tenant

### Owner

| Campo | Valor |
|---|---|
| **Nombre** | Roberto Giménez |
| **Email** | roberto.gimenez@demoinmobiliaria.com |
| **Password** | `Demo2026!` |
| **Rol** | owner |
| **Estado** | active |
| **Workspaces** | Todos (sin restricción por rol) |

### Recepcionista — Zona Norte

| Campo | Valor |
|---|---|
| **Nombre** | Analía Torres |
| **Email** | analia.torres@demoinmobiliaria.com |
| **Password** | `Demo2026!` |
| **Rol** | receptionist |
| **Estado** | active |
| **Workspaces asignados** | Zona Norte |
| **Nota de test** | Ve solo propiedades/conversaciones/reservas de Zona Norte |

### Recepcionista — Zona Sur

| Campo | Valor |
|---|---|
| **Nombre** | Marcos Salas |
| **Email** | marcos.salas@demoinmobiliaria.com |
| **Password** | `Demo2026!` |
| **Rol** | receptionist |
| **Estado** | active |
| **Workspaces asignados** | Zona Sur |
| **Nota de test** | Ve solo propiedades/conversaciones/reservas de Zona Sur |

### Recepcionista — General (sin restricción de workspace)

| Campo | Valor |
|---|---|
| **Nombre** | Patricia Vega |
| **Email** | patricia.vega@demoinmobiliaria.com |
| **Password** | `Demo2026!` |
| **Rol** | receptionist |
| **Estado** | active |
| **Workspaces asignados** | Ninguno (acceso total por defecto) |
| **Nota de test** | Ve todo — valida el caso "receptionist sin restricción = acceso total" |

---

## 5. AI Settings

| Campo | Valor |
|---|---|
| **Modelo** | claude-sonnet-4-6 |
| **Nombre del asistente** | Sofia |
| **System prompt** | *ver abajo* |
| **Keywords de escalamiento** | `["hablar con humano", "quiero hablar con alguien", "problema", "reclamo", "descuento especial"]` |
| **Max turnos antes de escalar** | 15 |
| **Delay de respuesta** | 1500ms |
| **Max mensajes de contexto** | 10 |

**System Prompt:**
```
Eres Sofia, la asistente virtual de Demo Inmobiliaria.
Somos una agencia especializada en alquileres temporarios.
Tu objetivo es ayudar a los clientes a encontrar la propiedad ideal y gestionar sus reservas.

Reglas:
- Responde siempre en el idioma del cliente.
- Sé amable, profesional y conciso. Canal: WhatsApp — máximo 3-4 párrafos.
- No inventes disponibilidades ni precios — usa las herramientas disponibles.
- Para confirmar una reserva, necesitás: nombre completo, DNI, huéspedes y fechas exactas.
- Los pagos se realizan por transferencia bancaria al CBU 0110012300001234567890.
- Precio incluye servicio de limpieza. No incluye ropa de cama (disponible a $5000 adicional).
```

---

## 6. WhatsApp Account

| Campo | Valor |
|---|---|
| **Número** | +54 9 11 2345-6789 |
| **Business Account ID** | `demo_business_account_id` |
| **Workspace** | General (todos los workspaces) |
| **Estado** | active |
| **Nota** | En desarrollo usar Meta Test Number — no requiere aprobación |

---

## 7. Propiedades y Unidades

### Propiedad 1 — Complejo Los Álamos (Zona Norte)

**Propiedad:**

| Campo | Valor |
|---|---|
| **Título** | Complejo Los Álamos |
| **Workspace** | Zona Norte |
| **Ciudad** | San Carlos de Bariloche |
| **Barrio** | Melipal |
| **Dirección** | Av. Los Álamos 1250 |
| **Descripción** | Complejo de cabañas con vista al lago, pileta climatizada y parrilla privada. A 5 min del centro. |
| **Publicada** | true |
| **Atributos** | `{ "pileta": true, "parrilla": true, "wifi": true, "cochera": true, "mascotas": false, "vista_lago": true, "calefaccion": "electrica" }` |

**Unidades de Propiedad 1:**

| Unidad | Capacidad | Precio/noche | Moneda | Estado |
|---|---|---|---|---|
| Cabaña Roble | 4 | 28000 | ARS | active |
| Cabaña Pino | 6 | 38000 | ARS | active |
| Cabaña Sauce | 2 | 20000 | ARS | active |

---

### Propiedad 2 — Departamentos Arrayán (Zona Norte)

**Propiedad:**

| Campo | Valor |
|---|---|
| **Título** | Departamentos Arrayán |
| **Workspace** | Zona Norte |
| **Ciudad** | San Carlos de Bariloche |
| **Barrio** | Centro |
| **Dirección** | Calle Moreno 340, Piso 3 |
| **Descripción** | Departamentos modernos en el centro de Bariloche. A pasos de restaurantes y comercios. |
| **Publicada** | true |
| **Atributos** | `{ "pileta": false, "wifi": true, "cochera": false, "mascotas": true, "calefaccion": "central", "balcon": true }` |

**Unidades de Propiedad 2:**

| Unidad | Capacidad | Precio/noche | Moneda | Estado |
|---|---|---|---|---|
| Depto 3A (1 dorm) | 2 | 15000 | ARS | active |
| Depto 3B (2 dorm) | 4 | 22000 | ARS | active |

---

### Propiedad 3 — Casas Pehuén (Zona Sur)

**Propiedad:**

| Campo | Valor |
|---|---|
| **Título** | Casas Pehuén |
| **Workspace** | Zona Sur |
| **Ciudad** | Villa La Angostura |
| **Barrio** | Las Balsas |
| **Dirección** | Ruta 231 km 18 |
| **Descripción** | Casas de montaña con jardín privado y chimenea. Entorno natural, total tranquilidad. |
| **Publicada** | true |
| **Atributos** | `{ "pileta": false, "parrilla": true, "wifi": true, "cochera": true, "mascotas": true, "chimenea": true, "jardin": true }` |

**Unidades de Propiedad 3:**

| Unidad | Capacidad | Precio/noche | Moneda | Estado |
|---|---|---|---|---|
| Casa Pehuén A | 6 | 45000 | ARS | active |
| Casa Pehuén B | 8 | 55000 | ARS | active |

---

### Propiedad 4 — Suite del Lago (Zona Sur, no publicada)

**Propiedad:**

| Campo | Valor |
|---|---|
| **Título** | Suite del Lago |
| **Workspace** | Zona Sur |
| **Ciudad** | Villa La Angostura |
| **Publicada** | **false** |
| **Nota** | Propiedad en carga — valida que anon no la ve pero owner/receptionist sí |

**Unidades de Propiedad 4:**

| Unidad | Capacidad | Precio/noche | Estado |
|---|---|---|---|
| Suite Premium | 2 | 80000 ARS | active |

---

### Propiedad 5 — Loft General (workspace general/null)

**Propiedad:**

| Campo | Valor |
|---|---|
| **Título** | Loft Centro |
| **Workspace** | NULL (sin workspace asignado — visible para todos) |
| **Ciudad** | San Carlos de Bariloche |
| **Publicada** | true |
| **Nota** | Valida que workspace_id=NULL hace visible la propiedad para todos los receptionists |
| **Atributos** | `{ "wifi": true, "mascotas": false }` |

**Unidades de Propiedad 5:**

| Unidad | Capacidad | Precio/noche | Estado |
|---|---|---|---|
| Loft A | 2 | 12000 ARS | active |

---

## 8. Contactos Demo

| Nombre | Teléfono | Email | Fuente | Nota de test |
|---|---|---|---|---|
| María García | +5491122334455 | maria.garcia@gmail.com | whatsapp | Contacto con historial de reservas |
| Juan Rodríguez | +5491133445566 | juan.rodriguez@gmail.com | whatsapp | Contacto nuevo sin historial |
| Ana Martínez | — | ana.martinez@hotmail.com | manual | Contacto sin teléfono (solo email) |
| Pedro López | +5491144556677 | — | whatsapp | Contacto sin email (solo teléfono) |
| Sofía Ruiz | +5491155667788 | sofia.ruiz@gmail.com | website | Contacto de sitio web |

---

## 9. Conversaciones Demo

### Conversación 1 — María García (activa, con reserva en progreso)

| Campo | Valor |
|---|---|
| **Contacto** | María García |
| **Workspace** | Zona Norte |
| **Canal** | whatsapp |
| **Fuente** | whatsapp_direct |
| **AI Mode** | auto |
| **Estado** | open |
| **Asignado a** | Analía Torres (Recepcionista Norte) |

**Mensajes:**

| Orden | Tipo | Contenido |
|---|---|---|
| 1 | customer | "Hola! Consulto disponibilidad para el fin de semana del 25-27 de julio para 4 personas" |
| 2 | ai | "¡Hola María! Soy Sofia de Demo Inmobiliaria. Para el fin de semana del 25-27 de julio encontré disponibilidad en la *Cabaña Roble* del Complejo Los Álamos: 4 personas, $28.000/noche, con pileta y vista al lago. ¿Te interesa avanzar?" |
| 3 | customer | "Sí! Me encanta. Mi DNI es 28.500.123, somos 2 adultos y 2 niños" |
| 4 | ai | "Perfecto María! Acabo de registrar tu pre-reserva: Cabaña Roble, 25-27 julio, 4 huéspedes. Total: $56.000 ARS. Tenés 48 horas para transferir al CBU 0110012300001234567890 y enviarnos el comprobante. ¡Esperamos tu llegada!" |

---

### Conversación 2 — Juan Rodríguez (escalada a humano)

| Campo | Valor |
|---|---|
| **Contacto** | Juan Rodríguez |
| **Workspace** | Zona Norte |
| **Canal** | whatsapp |
| **AI Mode** | human (escalado) |
| **Estado** | waiting |
| **Asignado a** | Analía Torres |

**Mensajes:**

| Orden | Tipo | Contenido |
|---|---|---|
| 1 | customer | "Quiero hacer una reserva y necesito un descuento especial por ser cliente frecuente" |
| 2 | ai | "¡Hola! Soy Sofia. Entiendo tu consulta sobre descuentos especiales. Este tipo de negociación la maneja nuestro equipo personalmente. ¡Un momento!" |
| 3 | ai | "He notificado al equipo de Demo Inmobiliaria y alguien te contactará a la brevedad. Muchas gracias por tu paciencia." |

---

### Conversación 3 — Sofía Ruiz (Zona Sur, abierta)

| Campo | Valor |
|---|---|
| **Contacto** | Sofía Ruiz |
| **Workspace** | Zona Sur |
| **Canal** | whatsapp |
| **Fuente** | website_button |
| **AI Mode** | auto |
| **Estado** | open |

**Mensajes:**

| Orden | Tipo | Contenido |
|---|---|---|
| 1 | customer | "Hola, consulto por Complejo Los Pinos - Casa Pehuén A [property_id:uuid][unit_id:uuid][source:website]" |
| 2 | ai | "¡Hola Sofía! Soy Sofia de Demo Inmobiliaria. Consultas por la Casa Pehuén A en Villa La Angostura — capacidad 6 personas, jardín, chimenea, parrilla, a $45.000/noche. ¿Para qué fechas lo necesitás?" |

---

### Conversación 4 — Pedro López (cerrada)

| Campo | Valor |
|---|---|
| **Contacto** | Pedro López |
| **Workspace** | Zona Norte |
| **Estado** | closed |
| **AI Mode** | human |

**Mensajes:**

| Orden | Tipo | Contenido |
|---|---|---|
| 1 | customer | "¿Tienen disponibilidad para agosto?" |
| 2 | ai | "¡Hola! Para agosto tenemos varias opciones disponibles..." |
| 3 | human | "Hola Pedro, te escribo Analía. ¿En qué fechas exactas de agosto estás pensando?" |
| 4 | customer | "Gracias, ya encontré algo. Hasta la próxima!" |
| 5 | human | "Perfecto! Cuando quieras. ¡Hasta la próxima!" |

---

## 10. Reservas Demo

### Reserva 1 — María García (PRE_RESERVED, expira en 48h)

| Campo | Valor |
|---|---|
| **Contacto** | María García |
| **Unidad** | Cabaña Roble (Complejo Los Álamos) |
| **Fechas** | 2026-07-25 al 2026-07-27 |
| **Huéspedes** | 4 |
| **Monto total** | ARS 56.000 |
| **Estado** | pre_reserved |
| **Expira en** | `now() + 48h` (calculado al insertar) |
| **Conversación** | Conversación 1 |
| **Nota** | Valida: AI creó pre-reserva correctamente |

### Reserva 2 — Ana Martínez (CONFIRMED)

| Campo | Valor |
|---|---|
| **Contacto** | Ana Martínez |
| **Unidad** | Casa Pehuén A (Casas Pehuén) |
| **Fechas** | 2026-07-10 al 2026-07-15 |
| **Huéspedes** | 5 |
| **Monto total** | ARS 225.000 |
| **Estado** | confirmed |
| **Nota** | Valida: owner/receptionist confirmaron la reserva |

### Reserva 3 — Pedro López (CANCELLED)

| Campo | Valor |
|---|---|
| **Contacto** | Pedro López |
| **Unidad** | Depto 3B (Departamentos Arrayán) |
| **Fechas** | 2026-08-01 al 2026-08-05 |
| **Huéspedes** | 3 |
| **Estado** | cancelled |
| **Nota** | Valida: reserva cancelada libera availability_blocks |

### Reserva 4 — Sofía Ruiz (INQUIRY)

| Campo | Valor |
|---|---|
| **Contacto** | Sofía Ruiz |
| **Unidad** | Casa Pehuén B (Casas Pehuén) |
| **Fechas** | 2026-08-20 al 2026-08-25 |
| **Huéspedes** | 7 |
| **Estado** | inquiry |
| **Nota** | Valida: estado inicial de la consulta |

---

## 11. Availability Blocks Demo

| Unidad | Start | End | Razón | Reserva vinculada |
|---|---|---|---|---|
| Cabaña Roble | 2026-07-25 | 2026-07-27 | reservation | Reserva 1 (María García) |
| Casa Pehuén A | 2026-07-10 | 2026-07-15 | reservation | Reserva 2 (Ana Martínez) |
| Cabaña Pino | 2026-07-20 | 2026-07-25 | maintenance | — (sin reserva) |
| Depto 3A | 2026-08-10 | 2026-08-12 | manual | — (bloqueado manualmente) |

**Nota de test:** Intentar crear una reserva en Cabaña Roble del 24-26 de julio debe fallar con el constraint `no_double_booking`. Verificar que la DB lanza el error sin necesidad de lógica en la aplicación.

---

## 12. Tareas Demo

| Título | Creado por | Asignado a | Contacto | Estado | Vence |
|---|---|---|---|---|---|
| Confirmar transferencia de María García | Analía Torres | Analía Torres | María García | pending | `now() + 48h` |
| Llamar a Juan Rodríguez por descuento | Analía Torres | Roberto Giménez (Owner) | Juan Rodríguez | in_progress | `now() + 24h` |
| Enviar reglamento del complejo a Ana Martínez | Roberto Giménez | Patricia Vega | Ana Martínez | completed | `now() - 48h` |
| Revisar instalación Wi-Fi en Cabaña Pino | Roberto Giménez | — | — | pending | `now() + 72h` |

---

## 13. Notas Demo

| Sobre | Creado por | Contenido |
|---|---|---|
| Contacto María García | Analía Torres | "Clienta frecuente. Prefiere cabaña con vista al lago. Viene con 2 niños pequeños — preguntar por cuna disponible." |
| Reserva 2 (Ana Martínez) | Roberto Giménez | "Pagó el 50% de adelanto el 2026-07-01. Saldo: $112.500 ARS. Confirmar fecha de pago final." |
| Conversación 2 (Juan Rodríguez) | Analía Torres | "IA escaló. Cliente solicitó descuento por ser frecuente — revisar historial antes de llamar." |

---

## 14. Documents Demo

| Nombre | Tipo | Ancla | Vinculado a |
|---|---|---|---|
| Reglamento Complejo Los Álamos | regulation | property | Complejo Los Álamos |
| Manual de uso Cabaña Roble | manual | unit | Cabaña Roble |
| DNI María García | contract | contact | María García |
| Contrato reserva Ana Martínez | contract | reservation | Reserva 2 |

---

## 15. Impersonation Session Demo

Para testear el flujo de impersonación:

| Campo | Valor |
|---|---|
| **SA** | Carlos Méndez |
| **Tenant objetivo** | Demo Inmobiliaria |
| **Razón** | "Revisión de setup inicial del tenant demo" |
| **Estado** | Crear una sesión activa (ended_at NULL) y una terminada (ended_at SET) |

**Test esperado:** Con sesión activa, Carlos Méndez puede ver propiedades de Demo Inmobiliaria sin tener perfil de `tenant_users`.

---

## 16. Flujos de Validación por Rol

### Test 1: Workspace Scoping de Receptionist

| Acción | Analía Torres (Norte) | Marcos Salas (Sur) | Patricia Vega (General) |
|---|---|---|---|
| Ver Complejo Los Álamos | ✅ | ❌ | ✅ |
| Ver Casas Pehuén | ❌ | ✅ | ✅ |
| Ver Loft Centro (workspace NULL) | ✅ | ✅ | ✅ |
| Ver Conversación 1 (Norte) | ✅ | ❌ | ✅ |
| Ver Conversación 3 (Sur) | ❌ | ✅ | ✅ |

### Test 2: Confirmación de Reservas

| Acción | IA | Receptionist | Owner |
|---|---|---|---|
| Crear pre_reserved | ✅ | ✅ | ✅ |
| Confirmar (pre_reserved → confirmed) | ❌ | ✅ | ✅ |
| Cancelar | ❌ | ✅ | ✅ |
| Soft delete (deleted_at) | ❌ | ❌ | ✅ |

### Test 3: Pipeline AI

```
1. Enviar mensaje de WhatsApp al número demo:
   "Hola, busco una cabaña para 4 personas con pileta para el 10-12 de agosto"

2. Verificar en message_queue:
   - Fila aparece con status = 'pending'
   - Worker la consume (status = 'processing')
   - AI llama search_properties con capacity=4, attributes={pileta:true}
   - AI genera respuesta con opciones
   - status = 'completed'

3. Verificar en messages:
   - Mensaje del cliente insertado (sender_type = 'customer')
   - Respuesta de la IA insertada (sender_type = 'ai')

4. Verificar en ai_usage_log:
   - Registro del uso de tokens para este intercambio
```

### Test 4: Double Booking (debe fallar)

```
Intentar crear un availability_block para:
  - Unidad: Cabaña Roble
  - Fechas: 2026-07-24 al 2026-07-26 (overlap con reserva existente 25-27)

Resultado esperado:
  - PostgreSQL error: violates exclusion constraint "no_double_booking"
  - La reserva NO se crea
  - La transacción se revierte completamente
```

---

## Notas de Implementación

- Los UUIDs se deben generar con `gen_random_uuid()` al insertar
- Los usuarios deben crearse primero en `auth.users` (via Supabase Admin API o Dashboard) y luego en las tablas `platform_users`/`tenant_users`
- El workspace "General" debe ser el primero en insertarse (se crea en onboarding)
- Los `availability_blocks` de las reservas confirmadas/pre-reserved deben insertarse junto con las reservas
- Los `expires_at` de la Reserva 1 deben calcularse como `now() + interval '48 hours'` al momento de la inserción
- Las imágenes de propiedades y unidades se suben a Supabase Storage y se referencia la URL en las tablas
