// Synthetic. The caller has the same shape as cross-file-case, but the receiver
// only writes sourceKey to an ordinary log, so no idempotency key depends on it.
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
