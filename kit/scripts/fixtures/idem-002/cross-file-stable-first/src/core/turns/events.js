// Synthetic receiver for cross-file-stable-first. Identical to the one in
// cross-file-case, so the only difference between the two trees is the order.
export async function openTurn({ db, shopId, sourceKey, note = null }) {
  return db.from('turn_events').upsert({
    shop_id: shopId,
    note,
    idempotency_key: `received:${sourceKey}`.slice(0, 200),
  }, { onConflict: 'shop_id,idempotency_key', ignoreDuplicates: true });
}
