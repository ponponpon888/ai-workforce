// Synthetic. The key is built here and used as an idempotency key in another
// file: the row id is chosen first, so it changes on every redelivery.
//
// Fixture only. Nothing here is imported or executed by the checker.
import { openTurn } from '@/core/turns/events';

export async function handleInbound(event, db, shop) {
  const { data: receivedRow, error: receivedRowError } = await db.from('inbound_rows').insert({
    shop_id: shop.id,
    body: event.message.text,
  }).select('id').maybeSingle();
  if (receivedRowError) throw receivedRowError;

  const turnKey = receivedRow?.id || event.message.id || `inbound:${Date.now()}`;

  return openTurn({
    db,
    shopId: shop.id,
    sourceKey: turnKey,
  });
}
