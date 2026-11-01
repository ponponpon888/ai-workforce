// The row id is chosen by the caller and written into the payload, so it is
// not new on every delivery: the same event produces the same id. The order of
// the chain is then not evidence of anything, and nothing is reported.
export async function handleLineWebhook(event, supabase, tenant) {
  const { data: incomingLog } = await supabase.from('chat_logs').insert({
    id: deterministicRowId(event),
    tenant_id: tenant.id,
    direction: 'incoming',
  }).select('id').maybeSingle();

  const conversationSourceKey = incomingLog?.id || event.message.id;

  await supabase.from('conversation_events').insert({
    tenant_id: tenant.id,
    idempotency_key: conversationSourceKey,
  });

  return conversationSourceKey;
}

function deterministicRowId(event) {
  return `line:${event.message.id}`;
}
