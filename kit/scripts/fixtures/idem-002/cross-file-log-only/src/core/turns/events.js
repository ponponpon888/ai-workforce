// Synthetic receiver for cross-file-log-only. The field name appears in a comment
// and a string, neither of which is a use:
// idempotency_key: `received:${sourceKey}`
export async function openTurn({ db, shopId, sourceKey }) {
  console.info('turn opened', { shopId, sourceKey });
  console.info("idempotency_key: `received:${sourceKey}`");
  return db.from('turn_events').insert({ shop_id: shopId, kind: 'received' });
}
