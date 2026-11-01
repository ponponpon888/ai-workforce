// The same shaped chain, in the same order, but its value never reaches an
// idempotency key: it is an audit field. The record is about a key that does
// not de-duplicate, not about the shape of an expression.
export async function handleLineWebhook(event, supabase, tenant) {
  const { data: incomingLog } = await supabase.from('chat_logs').insert({
    tenant_id: tenant.id,
    direction: 'incoming',
  }).select('id').maybeSingle();

  const conversationSourceKey = incomingLog?.id || event.message.id;

  await supabase.from('conversation_events').insert({
    tenant_id: tenant.id,
    audit_source_key: conversationSourceKey,
    kind: 'inbound',
  });

  return conversationSourceKey;
}
