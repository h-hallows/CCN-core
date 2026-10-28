#!/usr/bin/env node
/**
 * ccn-lint — the I9 build gate.
 *
 *   ccn-lint ./app ./components ./content
 *
 * Reads only text that can reach a human: string literals, template literals and JSX
 * text. Comments are stripped first, deliberately — the statutory words belong in
 * comments explaining why the rule exists, and flagging those would push the explanation
 * out of the code.
 *
 * Exits 1 on a hit, with file and line.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import {
  EMPLOYEE_ALLOWED_IN, EMPLOYEE_TERM, findIdentifierHits, FORBIDDEN_COPY,
  LINTED_EXTENSIONS,
} from './forbidden.mjs';

const ROOT = process.cwd();
const targets = process.argv.slice(2);

if (targets.length === 0) {
  console.error('usage: ccn-lint <dir> [dir...]');
  process.exit(2);
}

/**
 * Strip comments without disturbing string contents. A hand-rolled scan rather than a
 * regex, because `'https://x'` and `"/* not a comment *\/"` both defeat the regex version.
 */
function stripComments(source, ext) {
  if (ext === '.md') return source;                  // Markdown has no comment syntax here
  let out = '';
  let i = 0;
  const n = source.length;
  let state = 'code';
  let quote = '';

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (ext === '.sql' && c === '-' && next === '-') { state = 'line'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { state = 'string'; quote = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; }
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += '\n';                    // keep line numbers honest
      i++; continue;
    }
    // state === 'string'
    if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
    if (c === quote) { state = 'code'; quote = ''; out += c; i++; continue; }
    out += c; i++; continue;
  }
  return out;
}

function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (LINTED_EXTENSIONS.has(extname(name))) acc.push(full);
  }
  return acc;
}

function locate(text, index) {
  const upto = text.slice(0, index);
  return { line: upto.split('\n').length, col: index - upto.lastIndexOf('\n') };
}

const findings = [];

for (const target of targets) {
  for (const file of walk(resolve(ROOT, target))) {
    const ext = extname(file);
    const raw = readFileSync(file, 'utf8');
    const text = stripComments(raw, ext);
    const haystack = text.toLowerCase();

    const rel = relative(ROOT, file);
    // `employee` is permitted only inside the statutory texts.
    const terms = EMPLOYEE_ALLOWED_IN.some((allowed) => rel.includes(allowed))
      ? FORBIDDEN_COPY
      : [...FORBIDDEN_COPY, EMPLOYEE_TERM];

    for (const phrase of terms) {
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(phrase, from);
        if (at === -1) break;
        const { line, col } = locate(text, at);
        findings.push({
          file: rel, line, col, invariant: 'I9',
          message: phrase === EMPLOYEE_TERM
            ? `forbidden copy "${phrase}" — permitted only inside the statutory texts`
            : `forbidden copy "${phrase}" — providers are referred providers`,
        });
        from = at + phrase.length;
      }
    }

    if (ext === '.md') continue;                      // documentation names what it forbids
    for (const hit of findIdentifierHits(text)) {
      const { line, col } = locate(text, hit.index);
      findings.push({
        file: rel, line, col, invariant: hit.invariant,
        message: `forbidden identifier "${hit.match}" — see ${hit.invariant} in INVARIANTS.md`,
      });
    }
  }
}

if (findings.length === 0) {
  console.log(`ccn-lint: clean (I1, I2, I7, I8, I9) — ${targets.join(' ')}`);
  process.exit(0);
}

console.error(`ccn-lint: ${findings.length} violation${findings.length === 1 ? '' : 's'}\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}:${f.col}  [${f.invariant}]  ${f.message}`);
}
console.error('\nThese are statutory invariants, not style rules. See INVARIANTS.md.');
process.exit(1);
