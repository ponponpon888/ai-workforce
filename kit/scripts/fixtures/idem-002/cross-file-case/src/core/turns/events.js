// Synthetic receiver for cross-file-case. The unique constraint is on
// (shop_id, idempotency_key), and the value is built around sourceKey.
export async function openTurn({ db, shopId, sourceKey, note = null }) {
  return db.from('turn_events').upsert({
    shop_id: shopId,
    note,
    idempotency_key: `received:${sourceKey}`.slice(0, 200),
  }, { onConflict: 'shop_id,idempotency_key', ignoreDuplicates: true });
}
