-- Removes payments left by the pre-adapter build: old rail names (card, ach, rtp, usdc) and fake receipts
-- (chain base-sim, USDC-xxxx refs). Their journals, rail events and idempotency keys go too, and the invoice is unpaid again.
CREATE TEMP TABLE legacy_pi AS
  SELECT id FROM payment_intents
   WHERE json_extract(data, '$.rail') IN ('card','ach','rtp','usdc')
      OR json_extract(data, '$.route.rail') IN ('card','ach','rtp','usdc')
      OR EXISTS (SELECT 1 FROM json_each(json_extract(payment_intents.data, '$.route.options')) o WHERE json_extract(o.value, '$.rail') IN ('card','ach','rtp','usdc'))
  UNION SELECT intent_id FROM rail_events
   WHERE json_extract(data, '$.rail') IN ('card','ach','rtp','usdc') OR json_extract(data, '$.chain') LIKE '%sim%' OR json_extract(data, '$.railRef') LIKE 'USDC-%';
UPDATE invoices SET data = json_set(data, '$.paid', json('false'))
 WHERE id IN (SELECT json_extract(p.data, '$.invoiceId') FROM payment_intents p WHERE p.id IN (SELECT id FROM legacy_pi));
DELETE FROM rail_events WHERE intent_id IN (SELECT id FROM legacy_pi) OR json_extract(data, '$.rail') IN ('card','ach','rtp','usdc') OR json_extract(data, '$.chain') LIKE '%sim%';
DELETE FROM journals WHERE json_extract(data, '$.ref') IN (SELECT id FROM legacy_pi) OR json_extract(data, '$.memo') LIKE '% via card' OR json_extract(data, '$.memo') LIKE '% via ach' OR json_extract(data, '$.memo') LIKE '% via rtp' OR json_extract(data, '$.memo') LIKE '% via usdc' OR json_extract(data, '$.memo') IN ('Rail fee card','Rail fee ach','Rail fee rtp','Rail fee usdc');
DELETE FROM idempotency_keys WHERE intent_id IN (SELECT id FROM legacy_pi);
DELETE FROM payment_intents WHERE id IN (SELECT id FROM legacy_pi);
DROP TABLE legacy_pi;
