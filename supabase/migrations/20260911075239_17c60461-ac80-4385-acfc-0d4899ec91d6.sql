DO $$ DECLARE i integer; n integer; BEGIN
  FOR i IN 0..3 LOOP
    SELECT public.rebuild_unified_source_chunk(i, 8) INTO n;
    RAISE NOTICE 'chunk % rows %', i, n;
  END LOOP;
END $$;