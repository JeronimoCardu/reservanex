-- Add optional check-in / check-out time fields to properties
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS check_in_time  TIME,
  ADD COLUMN IF NOT EXISTS check_out_time TIME;
