import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes } from 'node:crypto';

const enabled = (process.env.TPA_LOG_LEVEL ?? 'debug') === 'debug';
const traceKey = enabled ? randomBytes(32) : null;
const scope = new AsyncLocalStorage();

export function jobTrace(familyId, jobId) {
  return traceKey && createHmac('sha256', traceKey)
    .update(JSON.stringify([familyId, jobId])).digest('hex').slice(0, 24);
}

export function debugEvent(trace, event, fields = {}) {
  if (!trace) return;
  try { console.log('DEBUG ' + JSON.stringify({ trace, event, ...fields })); }
  catch { /* Diagnostics must not interrupt processing. */ }
}

export function withJobTrace(trace, run) {
  return trace ? scope.run(trace, run) : run();
}

export function jobDebug(event, fields) {
  debugEvent(scope.getStore(), event, fields);
}

const errorNames = new Set(['Error', 'SyntaxError', 'TypeError', 'AbortError', 'TimeoutError', 'DatabaseError']);
const systemCodes = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EBUSY', 'EIO', 'ENOSPC',
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID'
]);
const sqlState = /^(?:08|22|23|25|28|40|42|53|54|55|57|58|XX)[0-9A-Z]{3}$/;

export function errorFields(error) {
  const code = [error?.code, error?.cause?.code].find(value =>
    typeof value === 'string' && (systemCodes.has(value) || sqlState.test(value)));
  return {
    errorType: errorNames.has(error?.name) ? error.name : 'other',
    code,
    httpStatus: Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599
      ? error.httpStatus : undefined
  };
}
