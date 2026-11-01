// The insert is in a helper and the key is built in the handler. Whether the
// id handed back is new per delivery cannot be settled from the handler alone,
// so this version does not report it rather than guessing across functions.
async function logIncoming(event, supabase, tenant) {
  const { data: incomingLog } = await supabase.from('chat_logs').insert({
    tenant_id: tenant.id,
    direction: 'incoming',
  }).select('id').maybeSingle();

  return incomingLog;
}

export async function handleLineWebhook(event, supabase, tenant) {
  const incomingLog = await logIncoming(event, supabase, tenant);

  const conversationSourceKey = incomingLog?.id || event.message.id;

  await supabase.from('conversation_events').insert({
    tenant_id: tenant.id,
    idempotency_key: conversationSourceKey,
  });

  return conversationSourceKey;
}
