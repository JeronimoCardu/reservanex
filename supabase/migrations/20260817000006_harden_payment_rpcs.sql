-- =============================================================================
-- 20260817000006_harden_payment_rpcs.sql
-- Hardening de RPCs de pagos mensuales:
--
-- record_monthly_rental_payment:
--   - Agrega FOR UPDATE en SELECT de monthly_rental_charges → evita race condition
--     donde dos pagos concurrentes leen el mismo amount_paid stale y ambos pasan
--     la validación de saldo, generando sobrepago.
--   - Calcula el saldo real desde SUM(active payments) antes del check, no desde
--     el campo amount_paid cacheado.
--
-- void_monthly_rental_payment:
--   - Agrega FOR UPDATE en SELECT de monthly_rental_payments → evita doble anulación
--     concurrente del mismo pago.
--   - Agrega FOR UPDATE en SELECT de monthly_rental_charges → consistencia del
--     recálculo de amount_paid.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.record_monthly_rental_payment(
  p_charge_id      uuid,
  p_amount         numeric,
  p_paid_at        date,
  p_payment_method text,
  p_notes          text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
AS $$
DECLARE
  v_tenant_id       uuid;
  v_charge          record;
  v_current_paid    numeric;
  v_payment_id      uuid;
  v_new_amount_paid numeric;
  v_new_status      text;
BEGIN
  -- Auth check
  v_tenant_id := public.auth_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no tenant context';
  END IF;
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Solo los owners pueden registrar pagos';
  END IF;

  -- Lock charge row: prevents concurrent payments from using stale amount_paid
  SELECT * INTO v_charge
  FROM public.monthly_rental_charges
  WHERE id = p_charge_id AND tenant_id = v_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cuota no encontrada';
  END IF;
  IF v_charge.status = 'cancelled' THEN
    RAISE EXCEPTION 'No se puede registrar un pago en una cuota cancelada';
  END IF;
  IF v_charge.status = 'paid' THEN
    RAISE EXCEPTION 'La cuota ya está completamente pagada';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'El monto debe ser mayor a 0';
  END IF;

  -- Real current paid: read from active payments, not the cached amount_paid column
  SELECT COALESCE(SUM(amount), 0) INTO v_current_paid
  FROM public.monthly_rental_payments
  WHERE charge_id = p_charge_id AND status = 'active';

  IF (v_current_paid + p_amount) > v_charge.total_amount THEN
    RAISE EXCEPTION 'El pago (%) supera el saldo pendiente (%) de la cuota',
      p_amount, (v_charge.total_amount - v_current_paid);
  END IF;

  -- Insert payment
  INSERT INTO public.monthly_rental_payments(
    tenant_id, contract_id, charge_id,
    amount, paid_at, payment_method, notes,
    status, created_by
  )
  VALUES (
    v_tenant_id, v_charge.contract_id, p_charge_id,
    p_amount, p_paid_at, p_payment_method, p_notes,
    'active', auth.uid()
  )
  RETURNING id INTO v_payment_id;

  -- Recalculate from all active payments (includes the one just inserted)
  SELECT COALESCE(SUM(amount), 0) INTO v_new_amount_paid
  FROM public.monthly_rental_payments
  WHERE charge_id = p_charge_id AND status = 'active';

  v_new_status := public.compute_charge_status_from_payment(
    v_new_amount_paid, v_charge.total_amount, v_charge.due_date
  );

  UPDATE public.monthly_rental_charges
  SET amount_paid = v_new_amount_paid, status = v_new_status
  WHERE id = p_charge_id;

  RETURN jsonb_build_object(
    'payment_id',  v_payment_id,
    'amount_paid', v_new_amount_paid,
    'new_status',  v_new_status
  );
END;
$$;

COMMENT ON FUNCTION public.record_monthly_rental_payment IS
  'Atómicamente inserta un pago activo y recalcula amount_paid+status de la cuota. FOR UPDATE previene sobrepago concurrente.';


CREATE OR REPLACE FUNCTION public.void_monthly_rental_payment(
  p_payment_id uuid,
  p_reason     text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER
AS $$
DECLARE
  v_tenant_id       uuid;
  v_payment         record;
  v_charge          record;
  v_new_amount_paid numeric;
  v_new_status      text;
BEGIN
  v_tenant_id := public.auth_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no tenant context';
  END IF;
  IF NOT public.is_owner() THEN
    RAISE EXCEPTION 'Solo los owners pueden anular pagos';
  END IF;

  -- Lock payment row: prevents concurrent double-void of the same payment
  SELECT * INTO v_payment
  FROM public.monthly_rental_payments
  WHERE id = p_payment_id AND tenant_id = v_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pago no encontrado';
  END IF;
  IF v_payment.status = 'voided' THEN
    RAISE EXCEPTION 'El pago ya está anulado';
  END IF;

  -- Lock charge row: ensures consistent recalculation of amount_paid
  SELECT * INTO v_charge
  FROM public.monthly_rental_charges
  WHERE id = v_payment.charge_id
  FOR UPDATE;

  -- Void payment
  UPDATE public.monthly_rental_payments
  SET
    status      = 'voided',
    voided_at   = now(),
    voided_by   = auth.uid(),
    void_reason = p_reason
  WHERE id = p_payment_id;

  -- Recalculate from remaining active payments (voided one is excluded)
  SELECT COALESCE(SUM(amount), 0) INTO v_new_amount_paid
  FROM public.monthly_rental_payments
  WHERE charge_id = v_payment.charge_id AND status = 'active';

  v_new_status := public.compute_charge_status_from_payment(
    v_new_amount_paid, v_charge.total_amount, v_charge.due_date
  );

  UPDATE public.monthly_rental_charges
  SET amount_paid = v_new_amount_paid, status = v_new_status
  WHERE id = v_payment.charge_id;

  RETURN jsonb_build_object(
    'charge_id',   v_payment.charge_id,
    'amount_paid', v_new_amount_paid,
    'new_status',  v_new_status
  );
END;
$$;

COMMENT ON FUNCTION public.void_monthly_rental_payment IS
  'Atómicamente anula un pago y recalcula amount_paid+status de la cuota. FOR UPDATE previene doble anulación concurrente.';
