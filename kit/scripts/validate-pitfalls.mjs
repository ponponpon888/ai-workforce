#!/usr/bin/env node
/**
 * validate-pitfalls.mjs — Check every pitfall record against data/pitfalls/_schema.json.
 *
 * The schema file is the definition, not a copy of one: shapes, enums, patterns and which
 * fields may appear are all read from it. Only the conditional rules are code, and each of
 * those carries the rule id that _schema.json lists under "rules", so an error message can
 * always be traced back to a line in the schema.
 *
 * The rule that matters most is the claim gate (R11): the word "measured" may only appear in
 * the prose of a record whose confidence is measured. Everything else here is bookkeeping;
 * that one is the reason the data exists.
 *
 *   node kit/scripts/validate-pitfalls.mjs
 *   node kit/scripts/validate-pitfalls.mjs --dir some/other/dir
 *
 * Exit 0 -> every record is valid.  Exit 1 -> at least one is not, reasons on stdout.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const schema = JSON.parse(readFileSync(join(repoRoot, 'data', 'pitfalls', '_schema.json'), 'utf8'));

const argv = process.argv.slice(2);
const dirArgs = argv.reduce((acc, arg, i) => (arg === '--dir' && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
const dirs = (dirArgs.length ? dirArgs : ['data/pitfalls', 'data/app-pitfalls']).map((d) => resolve(repoRoot, d));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const errors = [];
const err = (file, rule, message) => errors.push({ file, rule, message });

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/** Schema keys carrying documentation rather than definition. */
const isMeta = (key) => key.startsWith('$');

/**
 * GitHub-style heading anchor. Punctuation is dropped and whitespace becomes a hyphen, so
 * "### 3 つ目は、賢くしたせいで空きました" becomes "3-つ目は賢くしたせいで空きました".
 */
const PUNCTUATION = new RegExp(
  '[`~!@#$%^&*()+=<>?,.;:\'"\\\\|/\\[\\]{}。、，．・？！「」『』（）［］｛｝〈〉《》…—–]',
  'g'
);
const slugify = (text) => text.trim().toLowerCase().replace(PUNCTUATION, '').replace(/\s+/g, '-');

/** Every heading anchor in a markdown file. Fenced code blocks are not headings. */
const anchorCache = new Map();
function anchorsOf(absPath) {
  if (anchorCache.has(absPath)) return anchorCache.get(absPath);
  const anchors = new Set();
  let inFence = false;
  for (const line of readFileSync(absPath, 'utf8').split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) anchors.add(slugify(m[2]));
  }
  anchorCache.set(absPath, anchors);
  return anchors;
}

function typeOk(value, type) {
  if (type === 'string') return isNonEmptyString(value);
  if (type === 'string[]') return Array.isArray(value) && value.every(isNonEmptyString);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'object') return isPlainObject(value);
  return false;
}

/**
 * Whether a conditionally-present field is required, forbidden or merely allowed.
 * The rule id travels with the answer so the error can name the rule that decided it.
 */
function presenceOf(spec, record) {
  const { confidence, kind, status } = record;
  switch (spec.presence) {
    case 'always':
      return { need: 'required', rule: 'R02' };
    case 'optional':
      return { need: 'allowed', rule: 'R02' };
    case 'measured-only':
      return { need: confidence === 'measured' ? 'required' : 'forbidden', rule: 'R05' };
    case 'required-when-documented':
      return { need: confidence === 'documented' ? 'required' : 'allowed', rule: 'R07' };
    case 'required-when-inferred':
      return { need: confidence === 'inferred' ? 'required' : 'allowed', rule: 'R08' };
    case 'by-kind':
      return { need: kind === 'behaviour' ? 'forbidden' : 'required', rule: 'R09' };
    case 'required-when-closed':
      return { need: status === 'closed' ? 'required' : 'allowed', rule: 'R10' };
    case 'required-when-open-recorded':
      return { need: status === 'open_recorded' ? 'required' : 'allowed', rule: 'R10' };
    default:
      return { need: 'allowed', rule: 'R02' };
  }
}

// ---------------------------------------------------------------------------
// Per-record checks
// ---------------------------------------------------------------------------

function checkShape(record, file) {
  const fields = Object.entries(schema.fields).filter(([key]) => !isMeta(key));

  for (const key of Object.keys(record)) {
    if (!isMeta(key) && !schema.fields[key]) {
      err(file, 'R02', `unknown field "${key}"`);
    }
  }

  // A field whose own value decides other fields must be sound before it is trusted.
  const gateBroken =
    !schema.enums.confidence.includes(record.confidence) || !schema.enums.kind.includes(record.kind);

  for (const [key, spec] of fields) {
    const present = Object.prototype.hasOwnProperty.call(record, key);
    const conditional = spec.presence !== 'always' && spec.presence !== 'optional';

    if (!conditional || !gateBroken) {
      const { need, rule } = presenceOf(spec, record);
      if (need === 'required' && !present) {
        err(file, rule, `"${key}" is required here (confidence=${record.confidence}, kind=${record.kind}, status=${record.status})`);
        continue;
      }
      if (need === 'forbidden' && present) {
        err(file, rule, `"${key}" must not be present here (confidence=${record.confidence}, kind=${record.kind})`);
        continue;
      }
    }
    if (!present) continue;

    const value = record[key];
    if (!typeOk(value, spec.type)) {
      err(file, 'R03', `"${key}" must be a non-empty ${spec.type}`);
      continue;
    }
    if (spec.enum && !schema.enums[spec.enum].includes(value)) {
      err(file, 'R03', `"${key}" must be one of ${schema.enums[spec.enum].join(' | ')}, got "${value}"`);
    }
    if (spec.max_length && value.length > spec.max_length) {
      err(file, 'R03', `"${key}" is longer than ${spec.max_length} characters`);
    }
    if (spec.pattern_ref) {
      const allowed = spec.allow_unrecorded && value === schema.unrecorded;
      const rule = key === 'id' ? 'R04' : 'R16';
      if (!allowed && !new RegExp(schema[spec.pattern_ref]).test(value)) {
        err(file, rule, `"${key}" must match ${schema[spec.pattern_ref]}${spec.allow_unrecorded ? ` or be "${schema.unrecorded}"` : ''}, got "${value}"`);
      }
    }
  }
}

function checkMeasuredExtras(record, file) {
  if (record.confidence !== 'measured') return;
  if (Array.isArray(record.repro) && record.repro.length === 0) {
    err(file, 'R05', 'a measured record needs at least one repro step');
  }
  if (!isPlainObject(record.environment)) return;

  const expected = schema.environment.fields;
  for (const field of expected) {
    if (!isNonEmptyString(record.environment[field])) {
      err(file, 'R06', `environment.${field} is required: a value, or "${schema.unrecorded}"`);
    }
  }
  for (const key of Object.keys(record.environment)) {
    if (!expected.includes(key)) err(file, 'R06', `unknown environment field "${key}"`);
  }
}

function checkNonEmptyEvidence(record, file) {
  if (record.confidence === 'documented' && Array.isArray(record.sources) && record.sources.length === 0) {
    err(file, 'R07', 'a documented record needs at least one source');
  }
  if (record.confidence === 'inferred' && Array.isArray(record.inferred_from) && record.inferred_from.length === 0) {
    err(file, 'R08', 'an inferred record needs at least one entry in inferred_from');
  }
}

function checkClaimGate(record, file) {
  if (record.confidence === schema.claim_gate.allowed_when_confidence) return;
  const gate = new RegExp(schema.claim_gate.pattern);
  for (const field of schema.claim_gate.fields) {
    const value = record[field];
    if (typeof value !== 'string') continue;
    const hit = gate.exec(value);
    if (hit) {
      err(
        file,
        'R11',
        `"${field}" says "${hit[0]}", but confidence is "${record.confidence}". Only a measured record may claim a measurement.`
      );
    }
  }
}

function checkOrigin(record, file) {
  const origin = record.origin;
  if (typeof origin !== 'string') return;

  for (const pattern of schema.origin.line_number_patterns) {
    if (new RegExp(pattern).test(origin)) {
      err(file, 'R13', `origin "${origin}" points at a line number. Use a heading anchor: line numbers move silently.`);
      return;
    }
  }

  const hash = origin.indexOf('#');
  if (hash <= 0 || hash === origin.length - 1) {
    err(file, 'R13', `origin "${origin}" must be <path>#<heading anchor>`);
    return;
  }

  const relative = origin.slice(0, hash);
  const anchor = origin.slice(hash + 1);
  const absolute = join(repoRoot, relative);
  if (!existsSync(absolute)) {
    err(file, 'R13', `origin file does not exist: ${relative}`);
    return;
  }
  if (!anchorsOf(absolute).has(anchor)) {
    err(file, 'R14', `no heading in ${relative} has the anchor "#${anchor}"`);
  }
}

function checkDetection(record, file) {
  const detection = record.detection;
  if (!isPlainObject(detection)) return;

  const spec = schema.detection.fields;
  for (const key of Object.keys(detection)) {
    if (!isMeta(key) && !spec[key]) err(file, 'R15', `unknown detection field "${key}"`);
  }
  for (const [key, fieldSpec] of Object.entries(spec)) {
    const present = Object.prototype.hasOwnProperty.call(detection, key);
    const required =
      fieldSpec.presence === 'always' ||
      (fieldSpec.presence === 'required-when-checkable' && detection.checkable === true);

    if (required && !present) {
      err(file, 'R15', `detection.${key} is required${fieldSpec.presence === 'required-when-checkable' ? ' when checkable is true' : ''}`);
      continue;
    }
    if (!present) continue;
    if (!typeOk(detection[key], fieldSpec.type)) {
      err(file, 'R15', `detection.${key} must be a non-empty ${fieldSpec.type}`);
      continue;
    }
    if (fieldSpec.enum && !schema.enums[fieldSpec.enum].includes(detection[key])) {
      err(file, 'R15', `detection.${key} must be one of ${schema.enums[fieldSpec.enum].join(' | ')}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Load and run
// ---------------------------------------------------------------------------

const loaded = [];

for (const dir of dirs) {
  if (!existsSync(dir)) {
    console.log(`  (skipped, no such directory: ${dir})`);
    continue;
  }
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json') || name.startsWith('_')) continue;
    const file = `${basename(dir)}/${name}`;
    let record;
    try {
      record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch (e) {
      err(file, 'R17', `not valid JSON: ${e.message}`);
      continue;
    }
    if (!isPlainObject(record)) {
      err(file, 'R17', 'a record must be a JSON object');
      continue;
    }
    loaded.push({ record, file, name });
  }
}

const knownIds = new Set(loaded.map(({ record }) => record.id).filter(isNonEmptyString));

// Uniqueness has to be checked across sets, not per directory. Within one directory the file
// name already enforces it (R01); two sets can each hold a perm-001.json without noticing.
const seenIds = new Map();
for (const { record, file } of loaded) {
  if (!isNonEmptyString(record.id)) continue;
  const previous = seenIds.get(record.id);
  if (previous) err(file, 'R18', `id "${record.id}" is already used by ${previous}`);
  else seenIds.set(record.id, file);
}

for (const { record, file, name } of loaded) {
  if (isNonEmptyString(record.id) && name !== `${record.id}.json`) {
    err(file, 'R01', `file name does not match id "${record.id}" (expected ${record.id}.json)`);
  }
  checkShape(record, file);
  checkMeasuredExtras(record, file);
  checkNonEmptyEvidence(record, file);
  checkClaimGate(record, file);
  checkOrigin(record, file);
  checkDetection(record, file);

  if (Array.isArray(record.related)) {
    for (const target of record.related) {
      if (!knownIds.has(target)) err(file, 'R12', `related points at "${target}", which is not a record`);
    }
  }
}

const ruleText = Object.fromEntries(schema.rules.map((r) => [r.id, r.what]));

if (errors.length) {
  console.log('');
  for (const e of errors) {
    console.log(`  [${e.rule}] ${e.file}`);
    console.log(`         ${e.message}`);
    console.log(`         rule: ${ruleText[e.rule] || '(not listed in _schema.json)'}`);
  }
  console.log(`\n${errors.length} problem(s) in ${loaded.length} record(s).\n`);
  process.exit(1);
}

console.log(`\n${loaded.length} record(s) valid.\n`);
process.exit(0);
