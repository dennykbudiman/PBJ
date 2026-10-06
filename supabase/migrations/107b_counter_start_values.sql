-- Axle v2 · 107b counter start values (Oct 5, 16:23): job 100001, invoice INV-000001, stock PO 900001
update public.number_sequences set next_value = case name when 'job' then 100001 when 'invoice' then 1 when 'stock_po' then 1 end;
