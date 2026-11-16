
REVOKE EXECUTE ON FUNCTION public.nolead_buyer_rows(date, date) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nolead_buyer_summary(date, date) FROM anon, authenticated;
REVOKE SELECT ON public.buyer_classification FROM anon;
DROP POLICY IF EXISTS "buyer_classification readable" ON public.buyer_classification;
CREATE POLICY "buyer_classification readable" ON public.buyer_classification FOR SELECT TO authenticated USING (true);
