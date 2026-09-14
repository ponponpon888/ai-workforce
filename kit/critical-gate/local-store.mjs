/**
 * Experimental local accident guard, NOT a human-identity security boundary.
 * The owner/agent can edit this directory. Do not use it for production.
 * Single local filesystem only; no network/synced drives, power-loss guarantee,
 * rollback-resistant audit, cleanup, stale-lock recovery, or external execution.
 */
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, readFileSync, writeFileSync, fsyncSync, fstatSync,
  lstatSync, mkdirSync, constants } from 'node:fs';
import { resolve, join, parse, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { VERSION, MAX_BYTES, MAX_TTL_MS, GateError, requireGate, exactObject,
  validateId, actionHash, requestHash, confirmationText, canonical } from './protocol.mjs';

const freshId = () => randomUUID().replaceAll('-', '');
const sections = ['requests', 'approvals', 'claims', 'outcomes'];
const hashPattern = /^[a-f0-9]{64}$/;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function plainDirectory(path) {
  const item = lstatSync(path);
  requireGate(item.isDirectory() && !item.isSymbolicLink(), 'UNSAFE_DIRECTORY');
}
function checkAncestors(path) {
  const { root } = parse(path);
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { plainDirectory(current); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

export class LocalApprovalStore {
  #root;
  #clock;
  constructor(directory, { clock = Date.now } = {}) {
    requireGate(typeof directory === 'string' && directory.trim() !== '', 'STORE_REQUIRED');
    requireGate(typeof clock === 'function', 'INVALID_CLOCK');
    this.#root = resolve(directory);
    this.#clock = clock; // Trusted caller/test clock, never taken from request JSON.
    checkAncestors(this.#root);
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    plainDirectory(this.#root);
    for (const section of sections) {
      const path = join(this.#root, section);
      mkdirSync(path, { recursive: true, mode: 0o700 });
      plainDirectory(path);
    }
  }
  #now() {
    const now = this.#clock();
    requireGate(Number.isSafeInteger(now) && now >= 0, 'INVALID_CLOCK');
    return now;
  }
  #path(section, id) {
    validateId(id);
    plainDirectory(this.#root);
    plainDirectory(join(this.#root, section));
    return join(this.#root, section, id + '.json');
  }
  #exists(section, id) {
    try { lstatSync(this.#path(section, id)); return true; }
    catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  }
  #read(section, id) {
    const path = this.#path(section, id);
    let fd;
    try {
      const item = lstatSync(path);
      requireGate(item.isFile() && !item.isSymbolicLink(), 'UNSAFE_RECORD');
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = fstatSync(fd);
      requireGate(stat.isFile() && stat.size > 0 && stat.size <= MAX_BYTES, 'INVALID_RECORD_SIZE');
      const bytes = readFileSync(fd);
      requireGate(bytes.length <= MAX_BYTES, 'INVALID_RECORD_SIZE');
      return JSON.parse(strictUtf8.decode(bytes));
    } catch (err) {
      if (err instanceof GateError) throw err;
      throw new GateError(err.code === 'ENOENT' ? 'RECORD_MISSING' : 'UNREADABLE_RECORD');
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  #create(section, id, value) {
    const bytes = Buffer.from(canonical(value), 'utf8');
    requireGate(bytes.length <= MAX_BYTES, 'RECORD_TOO_LARGE');
    let fd;
    try {
      // No check-then-write, rename, deletion, or replacement. An empty record
      // left by a crash STILL blocks all later claims for this issuance ID.
      fd = openSync(this.#path(section, id), 'wx', 0o600);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } catch (err) {
      if (err instanceof GateError) throw err;
      throw new GateError(err.code === 'EEXIST' ? 'RECORD_EXISTS' : 'WRITE_FAILED');
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  #request(id) {
    const request = this.#read('requests', id);
    exactObject(request, ['version', 'id', 'action', 'actionHash', 'createdAt', 'expiresAt']);
    requireGate(request.version === VERSION && request.id === id, 'REQUEST_MISMATCH');
    requireGate(request.actionHash === actionHash(request.action), 'ACTION_TAMPERED');
    requireGate(Number.isSafeInteger(request.createdAt) && request.createdAt >= 0 &&
      Number.isSafeInteger(request.expiresAt) && request.expiresAt > request.createdAt &&
      request.expiresAt - request.createdAt <= MAX_TTL_MS, 'INVALID_REQUEST_TIME');
    return request;
  }
  #active(request) {
    const now = this.#now();
    requireGate(now >= request.createdAt, 'FUTURE_REQUEST');
    requireGate(now < request.expiresAt, 'EXPIRED');
  }
  #approval(request) {
    const approval = this.#read('approvals', request.id);
    exactObject(approval, ['version', 'id', 'requestHash', 'approvedAt']);
    requireGate(approval.version === VERSION && approval.id === request.id &&
      approval.requestHash === requestHash(request), 'APPROVAL_MISMATCH');
    requireGate(Number.isSafeInteger(approval.approvedAt) && approval.approvedAt >= request.createdAt &&
      approval.approvedAt < request.expiresAt && approval.approvedAt <= this.#now(), 'INVALID_APPROVAL_TIME');
    return approval;
  }
  request(action, { ttlMs = MAX_TTL_MS } = {}) {
    const hash = actionHash(action);
    requireGate(Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= MAX_TTL_MS, 'INVALID_TTL');
    const createdAt = this.#now();
    requireGate(Number.isSafeInteger(createdAt + ttlMs), 'INVALID_TTL');
    const request = { version: VERSION, id: freshId(), action: JSON.parse(canonical(action)),
      actionHash: hash, createdAt, expiresAt: createdAt + ttlMs };
    this.#create('requests', request.id, request);
    return request;
  }
  review(id) {
    const request = this.#request(validateId(id));
    return { request, confirmation: confirmationText(request), identityVerified: false,
      targetVerified: false, externalExecutionSupported: false };
  }
  approve(id, confirmation) {
    const request = this.#request(validateId(id));
    this.#active(request);
    requireGate(confirmation === confirmationText(request), 'CONFIRMATION_MISMATCH');
    requireGate(!this.#exists('claims', id), 'ALREADY_CLAIMED');
    const approval = { version: VERSION, id, requestHash: requestHash(request), approvedAt: this.#now() };
    this.#create('approvals', id, approval);
    return { id, state: 'approved', identityVerified: false };
  }
  claim(id, { expectedAction, currentRevision } = {}) {
    const request = this.#request(validateId(id));
    this.#active(request);
    requireGate(actionHash(expectedAction) === request.actionHash, 'ACTION_MISMATCH');
    requireGate(typeof currentRevision === 'string' && currentRevision === request.action.precondition.revision,
      'PRECONDITION_CHANGED');
    this.#approval(request);
    const receipt = { version: VERSION, id, claimId: freshId(), requestHash: requestHash(request), claimedAt: this.#now() };
    this.#create('claims', id, receipt);
    // I/O can run across the deadline. A spent record remains spent even here.
    this.#active(request);
    return { receipt, action: request.action, externalExecutionPerformed: false };
  }
  recordOutcome(receipt, outcome) {
    requireGate(receipt !== null && typeof receipt === 'object', 'INVALID_RECEIPT');
    const id = validateId(receipt.id);
    requireGate(['succeeded', 'failed'].includes(outcome), 'INVALID_OUTCOME');
    const request = this.#request(id);
    const claim = this.#read('claims', id);
    requireGate(canonical(receipt) === canonical(claim) && claim.requestHash === requestHash(request), 'RECEIPT_MISMATCH');
    requireGate(Number.isSafeInteger(claim.claimedAt) && claim.claimedAt <= this.#now(), 'INVALID_CLAIM_TIME');
    this.#create('outcomes', id, { version: VERSION, id, claimId: claim.claimId,
      requestHash: claim.requestHash, outcome, recordedAt: this.#now() });
    return { id, state: outcome, externallyVerified: false };
  }
  status(id) {
    const request = this.#request(validateId(id));
    // A claim dominates expiry and any malformed/partial outcome. Never return
    // "approved" again just because a process, result write, or deadline failed.
    if (this.#exists('claims', id)) {
      try {
        const claim = this.#read('claims', id);
        exactObject(claim, ['version', 'id', 'claimId', 'requestHash', 'claimedAt']);
        validateId(claim.claimId);
        requireGate(claim.version === VERSION && claim.id === id && claim.requestHash === requestHash(request) &&
          Number.isSafeInteger(claim.claimedAt) && claim.claimedAt >= request.createdAt &&
          claim.claimedAt < request.expiresAt && claim.claimedAt <= this.#now(), 'INVALID_CLAIM');
        const result = this.#read('outcomes', id);
        exactObject(result, ['version', 'id', 'claimId', 'requestHash', 'outcome', 'recordedAt']);
        requireGate(result.version === VERSION && result.id === id && result.claimId === claim.claimId &&
          hashPattern.test(result.requestHash) && result.requestHash === claim.requestHash &&
          ['succeeded', 'failed'].includes(result.outcome) && Number.isSafeInteger(result.recordedAt) &&
          result.recordedAt >= claim.claimedAt && result.recordedAt <= this.#now(), 'INVALID_OUTCOME');
        return { id, state: result.outcome, reusable: false, externallyVerified: false };
      } catch { return { id, state: 'outcome-unknown', reusable: false, externallyVerified: false }; }
    }
    if (this.#now() >= request.expiresAt) return { id, state: 'expired', reusable: false };
    this.#active(request);
    if (this.#exists('approvals', id)) {
      this.#approval(request);
      return { id, state: 'approved', reusable: false };
    }
    return { id, state: 'pending', reusable: false };
  }
}
