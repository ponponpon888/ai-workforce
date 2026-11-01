// Synthetic. The same path as cross-file-case, with the repair applied: the key
// that arrived with the delivery is chosen before the row id.
//
// Fixture only. Nothing here is imported or executed by the checker.
import { openTurn } from '@/core/turns/events';

export async function handleInbound(event, db, shop) {
  const { data: receivedRow, error: receivedRowError } = await db.from('inbound_rows').insert({
    shop_id: shop.id,
    body: event.message.text,
  }).select('id').maybeSingle();
  if (receivedRowError) throw receivedRowError;

  const turnKey = event.message.id || receivedRow?.id || `inbound:${Date.now()}`;

  return openTurn({
    db,
    shopId: shop.id,
    sourceKey: turnKey,
  });
}
