-- Migration: 20260624000001_phase4_crm_notifications_read_at.sql
-- MIG-1 (B7): Agrega read_at a notifications para tracking de leídas.
-- Reemplaza el uso de status como proxy de lectura.
--
-- Rollback:
--   ALTER TABLE notifications DROP COLUMN IF EXISTS read_at;

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ NULL;

-- Index para filtrar notificaciones no leídas eficientemente
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (tenant_id, recipient_id, channel)
  WHERE read_at IS NULL;
