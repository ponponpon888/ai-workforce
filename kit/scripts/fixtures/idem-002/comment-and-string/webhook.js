// The whole broken statement appears twice here, once commented out and once
// as the text of a string. Neither is code, so neither is a finding.
export async function handleLineWebhook(event, supabase, tenant) {
  const { data: incomingLog } = await supabase.from('chat_logs').insert({
    tenant_id: tenant.id,
    direction: 'incoming',
  }).select('id').maybeSingle();

  // const conversationSourceKey = incomingLog?.id || event.message.id;
  // await supabase.from('conversation_events').insert({ idempotency_key: conversationSourceKey });

  /*
   * const conversationSourceKey = incomingLog?.id || event.message.id;
   * idempotency_key: conversationSourceKey
   */

  const migrationNote = "const conversationSourceKey = incomingLog?.id || event.message.id; idempotency_key: conversationSourceKey";

  return { rowId: incomingLog?.id, migrationNote };
}
