/** Experimental protocol only. No database, MCP, or production execution. */
import { createHash } from 'node:crypto';

export const VERSION = 1;
export const POLICY = 'local-sandbox-v1';
export const MAX_TTL_MS = 15 * 60 * 1000;
export const MAX_BYTES = 128 * 1024;

export class GateError extends Error {
  constructor(code) { super(code); this.name = 'GateError'; this.code = code; }
}
export function requireGate(condition, code) {
  if (!condition) throw new GateError(code);
}
export function exactObject(value, keys) {
  requireGate(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_OBJECT');
  const actual = Object.keys(value).sort();
  requireGate(JSON.stringify(actual) === JSON.stringify([...keys].sort()), 'INVALID_FIELDS');
}
function text(value, max = 256) {
  requireGate(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'INVALID_TEXT');
  requireGate(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), 'CONTROL_CHARACTER');
  // Reject unpaired surrogates; UTF-8 replacement must not create hash aliases.
  requireGate(Buffer.from(value, 'utf8').toString('utf8') === value, 'INVALID_UNICODE');
}
function identifier(value) {
  text(value);
  requireGate(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(value), 'INVALID_IDENTIFIER');
}
export function validateId(id) {
  requireGate(typeof id === 'string' && /^[a-f0-9]{32}$/.test(id), 'INVALID_ID');
  return id;
}

/** Strictly scoped sandbox request. Labels are NOT evidence of a real target. */
export function validateAction(action) {
  exactObject(action, ['version', 'kind', 'toolName', 'target', 'parameters', 'precondition', 'policyVersion']);
  requireGate(action.version === VERSION && action.kind === 'sql.ddl', 'UNSUPPORTED_ACTION');
  requireGate(action.policyVersion === POLICY, 'POLICY_MISMATCH');
  identifier(action.toolName);
  exactObject(action.target, ['provider', 'projectId', 'environment']);
  requireGate(action.target.provider === 'supabase', 'UNSUPPORTED_PROVIDER');
  requireGate(action.target.environment === 'sandbox', 'PRODUCTION_NOT_SUPPORTED');
  identifier(action.target.projectId);
  exactObject(action.parameters, ['query']);
  text(action.parameters.query, 64 * 1024);
  // Conservative prefilter, NOT a SQL parser or execution authorization.
  requireGate(!/\b(?:DROP|TRUNCATE|DELETE|UPDATE|DO)\b/i.test(action.parameters.query), 'FORBIDDEN_SQL');
  requireGate(/\b(?:CREATE|ALTER|GRANT|REVOKE|REINDEX|VACUUM)\b/i.test(action.parameters.query), 'UNSUPPORTED_SQL');
  exactObject(action.precondition, ['revision']);
  identifier(action.precondition.revision);
  return action;
}

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  requireGate(value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isSafeInteger(value)), 'INVALID_JSON_VALUE');
  return JSON.stringify(value);
}
export function digest(domain, value) {
  return createHash('sha256').update(domain + '\0' + canonical(value), 'utf8').digest('hex');
}
export function actionHash(action) {
  validateAction(action);
  return digest('aiwf-critical-action-v1', action);
}
export function requestHash(request) {
  return digest('aiwf-critical-request-v1', request);
}
export function confirmationText(request) {
  return `APPROVE ${validateId(request.id)} ${request.action.target.projectId} ${request.actionHash.slice(0, 12)}`;
}
