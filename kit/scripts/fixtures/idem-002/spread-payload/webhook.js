// Reviewed 2026-11-01. The payload is spread from elsewhere, so whether it
// carries an id is decided in another expression. "no id in the payload" would
// be a claim this file cannot support, so nothing is reported.
export async function handleLineWebhook(event, supabase, tenant, payload) {
  const { data: incomingLog } = await supabase.from('chat_logs').insert({
    ...payload,
    direction: 'incoming',
  }).select('id').maybeSingle();

  const conversationSourceKey = incomingLog?.id || event.message.id;

  await supabase.from('conversation_events').insert({
    tenant_id: tenant.id,
    idempotency_key: conversationSourceKey,
  });
}
