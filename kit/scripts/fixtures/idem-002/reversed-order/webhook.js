// The repair from the record: the identifier that arrives with the delivery
// comes first, and the log row id is only the fallback. Same file otherwise.
export async function handleLineWebhook(event, supabase, tenant) {
  const { data: incomingLog } = await supabase.from('chat_logs').insert({
    tenant_id: tenant.id,
    direction: 'incoming',
    message_text: event.message.text,
  }).select('id').maybeSingle();

  const conversationSourceKey = event.message.id || incomingLog?.id || `line:${Date.now()}`;

  await supabase.from('conversation_events').insert({
    tenant_id: tenant.id,
    idempotency_key: conversationSourceKey,
    kind: 'inbound',
  });

  return conversationSourceKey;
}
