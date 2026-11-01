// An upsert on an external key can hand back the id of a row that was already
// there, so the id is not necessarily new per delivery. Not reported.
export async function handleLineWebhook(event, supabase, tenant) {
  const { data: incomingLog } = await supabase.from('chat_logs').upsert({
    tenant_id: tenant.id,
    external_id: event.message.id,
    direction: 'incoming',
  }, { onConflict: 'tenant_id,external_id' }).select('id').maybeSingle();

  const conversationSourceKey = incomingLog?.id || event.message.id;

  await supabase.from('conversation_events').insert({
    tenant_id: tenant.id,
    idempotency_key: conversationSourceKey,
  });

  return conversationSourceKey;
}
