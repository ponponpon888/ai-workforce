// Reproduces data/app-pitfalls/idem-002.json as it stood in the original case
// (docs/case-studies/musubu.md). The column and the unique constraint both
// exist; what is wrong is that the key picks the new log row id first.
//
// Fixture only. Nothing here is imported or executed by the checker.
export async function handleLineWebhook(event, supabase, tenant) {
  const { data: incomingLog } = await supabase.from('chat_logs').insert({
    tenant_id: tenant.id,
    line_user_id: event.source.userId,
    channel_type: 'customer',
    direction: 'incoming',
    message_text: event.message.text,
  }).select('id').maybeSingle();

  const conversationSourceKey = incomingLog?.id || event.message.id || `line:${Date.now()}`;

  await supabase.from('conversation_events').insert({
    tenant_id: tenant.id,
    idempotency_key: conversationSourceKey,
    kind: 'inbound',
  });

  return conversationSourceKey;
}
