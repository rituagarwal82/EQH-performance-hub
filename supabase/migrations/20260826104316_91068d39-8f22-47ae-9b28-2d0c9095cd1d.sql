CREATE TABLE public.products (
  mango_id text PRIMARY KEY,
  title text NOT NULL,
  product_type text,
  price numeric(12,2),
  currency text DEFAULT 'INR',
  subscriber_count integer,
  tier text CHECK (tier IS NULL OR tier IN ('L1_SILVER','L2','L3_DIAMOND','OTHER')),
  counts_as_sale boolean NOT NULL DEFAULT false,
  notes text,
  last_synced_at timestamptz DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, UPDATE ON public.products TO authenticated;
GRANT ALL ON public.products TO service_role;

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read products"
  ON public.products FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated can classify products"
  ON public.products FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Service role manages products"
  ON public.products FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX products_subscriber_count_idx ON public.products (subscriber_count DESC NULLS LAST);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_products_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.products (mango_id, title, tier, counts_as_sale, notes) VALUES
  ('66112b0d83d0cc73c3b6916b', 'Diamond long-term', 'L3_DIAMOND', false, 'Confirmed by owner; catalogue details not yet synced from TagMango.'),
  ('66112b5c83d0cc73c3b6c643', 'Diamond certification', 'L3_DIAMOND', false, 'Confirmed by owner; catalogue details not yet synced from TagMango.');