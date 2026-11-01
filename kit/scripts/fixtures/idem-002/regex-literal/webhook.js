// Reviewed 2026-11-01. Regex literals holding braces, slashes, quotes and a
// backtick, plus plain division, with the original case right after them. The
// regexes must not produce a diagnostic of their own, and must not move or
// swallow the real one: an unbalanced `}` inside /\{[^}]*\}/ used to end the
// function body early and the finding below was lost.
export async function handleLineWebhook(event, supabase, tenant) {
  const braces = /\{[^}]*\}/g;
  const slashes = /https?:\/\/[^\s]+/;
  const quotes = /['"`]/g;
  const unmatched = /[{]|[}]/;
  const ratio = tenant.quota / tenant.seats / 2;

  const { data: incomingLog } = await supabase.from('chat_logs').insert({
    tenant_id: tenant.id,
    message_text: event.message.text.replace(braces, '').replace(quotes, ''),
  }).select('id').maybeSingle();

  const conversationSourceKey = incomingLog?.id || event.message.id;

  await supabase.from('conversation_events').insert({
    tenant_id: tenant.id,
    idempotency_key: conversationSourceKey,
  });

  return { slashes, unmatched, ratio };
}
