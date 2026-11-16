DO $$ DECLARE i integer; n integer; BEGIN
  FOR i IN 4..7 LOOP SELECT public.rebuild_unified_source_chunk(i, 8) INTO n; END LOOP;
  SELECT public.apply_first_touch_source() INTO n;
  RAISE NOTICE 'first touch %', n;
END $$;