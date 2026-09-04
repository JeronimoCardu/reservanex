# OrderFlow - Modelo de Datos V1

# Arquitectura

Sistema multi-tenant.

Todas las entidades comerciales deben estar asociadas a un tenant.

---

# tenants

Representa una inmobiliaria.

Campos:

* id
* name
* slug
* logo_url
* primary_color
* secondary_color
* status
* created_at
* updated_at

---

# users

Usuarios internos.

Campos:

* id
* tenant_id
* role_id
* name
* email
* phone
* active
* created_at

---

# roles

Roles del sistema.

Campos:

* id
* name

Valores:

* super_admin
* seller
* owner
* receptionist

---

# branches

Sucursales.

Campos:

* id
* tenant_id
* name
* address
* city
* phone
* email

---

# properties

Complejos, edificios o propiedades.

Campos:

* id
* tenant_id
* branch_id
* title
* description
* city
* neighborhood
* address
* google_maps_url
* published
* created_at

---

# property_attributes

Campos dinámicos.

Ejemplos:

* wifi
* mascotas
* pileta
* cochera

Campos:

* id
* property_id
* name
* value

---

# units

Unidades reservables.

Ejemplos:

* Cabaña 1
* Depto 102

Campos:

* id
* tenant_id
* property_id
* name
* capacity
* price
* active

---

# unit_images

Imágenes.

Campos:

* id
* unit_id
* image_url
* sort_order

---

# contacts

Clientes.

Campos:

* id
* tenant_id
* name
* phone
* email
* notes
* created_at

---

# conversations

Conversaciones.

Campos:

* id
* tenant_id
* contact_id
* assigned_user_id
* status
* channel
* ai_enabled
* created_at

Estados:

* open
* waiting
* closed

---

# messages

Mensajes.

Campos:

* id
* conversation_id
* sender_type
* content
* metadata
* created_at

sender_type:

* customer
* ai
* human

---

# reservations

Reservas.

Campos:

* id
* tenant_id
* contact_id
* unit_id
* start_date
* end_date
* guests
* total_amount
* status
* created_at

Estados:

* inquiry
* interested
* pre_reserved
* pending_payment
* confirmed
* cancelled

---

# availability_blocks

Bloqueos de calendario.

Campos:

* id
* unit_id
* reservation_id
* start_date
* end_date
* reason

Motivos:

* reservation
* maintenance
* manual

---

# documents

Documentos de negocio.

Campos:

* id
* tenant_id
* property_id
* name
* file_url
* document_type

Tipos:

* contract
* regulation
* policy
* manual

---

# tasks

Tareas.

Campos:

* id
* tenant_id
* assigned_to
* contact_id
* reservation_id
* title
* description
* due_date
* status

Estados:

* pending
* in_progress
* completed
* cancelled

---

# notes

Notas internas.

Campos:

* id
* tenant_id
* contact_id
* user_id
* content
* created_at

---

# notifications

Notificaciones.

Campos:

* id
* tenant_id
* type
* destination
* payload
* sent_at

---

# whatsapp_accounts

Configuración WhatsApp.

Campos:

* id
* tenant_id
* phone_number
* business_account_id
* access_token_encrypted
* webhook_secret

---

# ai_settings

Configuración IA.

Campos:

* id
* tenant_id
* model
* system_prompt
* escalation_rules
* active

---

# seller_clients

Relación vendedor-cliente.

Campos:

* id
* seller_id
* tenant_id
* commission_percentage
* active

---

# audit_logs

Auditoría.

Campos:

* id
* tenant_id
* user_id
* action
* entity_type
* entity_id
* created_at

Todo cambio importante debe registrarse.
