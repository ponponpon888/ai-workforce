// Reviewed 2026-11-01. The outer chain does select the row id first, but the
// value that reaches idempotency_key is an inner declaration of the same name,
// bound to the delivery identifier. Which binding reaches the field is not
// settled by reading text in order, so a shadowed name is not reported.
export async function handleLineWebhook(event, supabase, tenant) {
  const { data: incomingLog } = await supabase.from('chat_logs').insert({
    tenant_id: tenant.id,
    direction: 'incoming',
  }).select('id').maybeSingle();

  const conversationSourceKey = incomingLog?.id || event.message.id;
  await supabase.from('audit_log').insert({ source_key: conversationSourceKey });

  if (event.type === 'message') {
    const conversationSourceKey = event.message.id;
    await supabase.from('conversation_events').insert({
      tenant_id: tenant.id,
      idempotency_key: conversationSourceKey,
    });
  }
}
