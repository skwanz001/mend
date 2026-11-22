// mend: the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none. SPEC.md is the contract.
//
// The last lines hand a trial over to runner.ts when MAKEFUN_ENV_URL is set:
// keep them as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file as lines: its own break, its lines, whether it ends with a break. */
interface FileDoc {
  br: string;
  lines: string[];
  finalBr: boolean;
}

function parseFile(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { br, lines: parts, finalBr };
}

function renderFile(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.finalBr ? doc.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Move pairs recorded by edits that succeeded, for the `R` output lines. */
const movePairs: Array<[string, string]> = [];

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const t = s.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const on = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(lines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** A line of N: `ctx` is its index in O when it is a context line, else -1. */
interface NLine {
  text: string;
  ctx: number;
}

/** Build the replacement lines: context lines are the file's own matched lines,
 *  other lines are re-indented at tier 2 from O's base indent to the file's. */
function buildReplacement(n: NLine[], fileLines: string[], at: number, tier: number, o: string[]): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWs(fileLines[at] ?? '');
    p = leadingWs(o[0]!);
  }
  const out: string[] = [];
  for (const nl of n) {
    if (nl.ctx >= 0) {
      out.push(fileLines[at + nl.ctx]!);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const doc = parseFile(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      doc.lines.splice(line, 0, ...add);
      tree.now.set(p, renderFile(doc));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

type BodyKind = 'ctx' | 'old' | 'new' | 'bs';
interface BodyLine {
  kind: BodyKind;
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** Path from a `--- ` / `+++ ` line: text after the four characters, up to the
 *  first tab, surrounding spaces removed; `/dev/null` means no file, a leading
 *  `a/` or `b/` is removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** O is the hunk's context and `-` lines, N its context and `+` lines. */
function hunkON(h: Hunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last line of one of the given kinds. */
function bsAfterLast(h: Hunk, kinds: BodyKind[]): boolean {
  let last = -1;
  for (let i = 0; i < h.body.length; i++) {
    if (kinds.includes(h.body[i]!.kind)) last = i;
  }
  if (last < 0) return false;
  return h.body[last + 1]?.kind === 'bs';
}

/** Apply a section's hunks in order to a file's lines (mutates `doc`). */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h);
    if (o.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), doc.lines.length);
      const atEnd = pos === doc.lines.length;
      const repl = n.map((x) => x.text);
      doc.lines.splice(pos, 0, ...repl);
      if (atEnd) doc.finalBr = !bsAfterLast(h, ['ctx', 'new']);
      d += repl.length;
    } else {
      const found = findTier(doc.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + o.length === doc.lines.length;
      const repl = buildReplacement(n, doc.lines, best, found.tier, o);
      doc.lines.splice(best, o.length, ...repl);
      if (atEnd) doc.finalBr = !bsAfterLast(h, ['ctx', 'new']);
      d += repl.length - o.length;
    }
  }
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    if (sec.isCreate) {
      const p = sec.newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      let endsBreak = true;
      for (let i = sec.hunks.length - 1; i >= 0; i--) {
        if (sec.hunks[i]!.body.some((b) => b.kind === 'new')) {
          endsBreak = !bsAfterLast(sec.hunks[i]!, ['new']);
          break;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (endsBreak ? '\n' : ''));
      return;
    }
    if (sec.isDelete) {
      const p = sec.oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = sec.oldPath ?? '';
    const newP = sec.newPath ?? '';
    const isMove = oldP !== newP;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const doc = parseFile(cur);
    applyHunks(doc, sec.hunks, strict, oldP);
    const text = renderFile(doc);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      movePairs.push([oldP, newP]);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let gitOld: string | null = null;
  let gitNew: string | null = null;
  let hasPair = false;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let newFile = false;
  let deletedFile = false;
  let oldNull = false;
  let newNull = false;
  let inHunks = false;

  const finishSection = (): void => {
    if (cur === null) return;
    const oldPath = hasPair || renameFrom !== null ? (oldNull ? null : (cur.oldPath ?? renameFrom ?? gitOld)) : gitOld;
    const newPath = hasPair || renameTo !== null ? (newNull ? null : (cur.newPath ?? renameTo ?? gitNew)) : gitNew;
    const isCreate = oldNull || newFile;
    const isDelete = newNull || deletedFile;
    sections.push({ oldPath, newPath, isCreate: isCreate && !isDelete, isDelete, hunks: cur.hunks });
    cur = null;
  };

  const startSection = (gOld: string | null, gNew: string | null): void => {
    finishSection();
    cur = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
    gitOld = gOld;
    gitNew = gNew;
    hasPair = false;
    renameFrom = null;
    renameTo = null;
    newFile = false;
    deletedFile = false;
    oldNull = false;
    newNull = false;
    inHunks = false;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null) startSection(null, null);
      else if (hasPair || inHunks) startSection(null, null);
      // This pair is the current section's header pair.
      cur!.oldPath = headerPath(line);
      cur!.newPath = headerPath(lines[i + 1]!);
      oldNull = cur!.oldPath === null;
      newNull = cur!.newPath === null;
      hasPair = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (!inHunks) {
      if (line.startsWith('--- ')) {
        // A `--- ` line inside a header, not followed by `+++ `.
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        renameFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        renameTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        deletedFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        const m = HUNK_HEAD.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        inHunks = true;
        const hunk: Hunk = { a: Number(m[1]), body: [] };
        cur.hunks.push(hunk);
        i += 1;
        // Hunk body: lines starting with ' ', '-', '+', '\', or empty.
        while (i < lines.length) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b === '') hunk.body.push({ kind: 'ctx', text: '' });
          else if (b[0] === ' ') hunk.body.push({ kind: 'ctx', text: b.slice(1) });
          else if (b[0] === '-') hunk.body.push({ kind: 'old', text: b.slice(1) });
          else if (b[0] === '+') hunk.body.push({ kind: 'new', text: b.slice(1) });
          else if (b[0] === '\\') hunk.body.push({ kind: 'bs', text: b.slice(1) });
          else break;
          i += 1;
        }
        // Empty lines at the end of a body are not part of it.
        while (hunk.body.length > 0) {
          const last = hunk.body[hunk.body.length - 1]!;
          if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
          else break;
        }
        continue;
      }
      // index, old mode, new mode, similarity index, Index:, any other line: ignored.
      i += 1;
      continue;
    }
    // After the first hunk: a new hunk, or an ignored line.
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') hunk.body.push({ kind: 'ctx', text: '' });
        else if (b[0] === ' ') hunk.body.push({ kind: 'ctx', text: b.slice(1) });
        else if (b[0] === '-') hunk.body.push({ kind: 'old', text: b.slice(1) });
        else if (b[0] === '+') hunk.body.push({ kind: 'new', text: b.slice(1) });
        else if (b[0] === '\\') hunk.body.push({ kind: 'bs', text: b.slice(1) });
        else break;
        i += 1;
      }
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
        else break;
      }
      continue;
    }
    i += 1;
  }
  finishSection();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = parseFile(cur);
    const found = findTier(doc.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const repl = buildReplacement(
      newLines.map((t) => ({ text: t, ctx: -1 })),
      doc.lines,
      at,
      found.tier,
      oldLines,
    );
    doc.lines.splice(at, oldLines.length, ...repl);
    tree.now.set(path, renderFile(doc));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (true) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let m = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        m = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (m < 0) throw new Exit2(`error: parse ${s + 1}`);
    let r = -1;
    for (let j = m + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        r = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (r < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, m), lines.slice(m + 1, r), strict));
    prevPath = path;
    prevEnd = r + 1;
    i = r + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}

type VSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[] };

function v4aEdit(sec: VSection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    const path = sec.path;
    const addLines = sec.lines;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    const path = sec.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  const path = sec.path;
  const moveTo = sec.moveTo;
  const chunks = sec.chunks;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = parseFile(cur);
    let cursor = 0;
    const maxTier = strict ? 0 : 2;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        let foundIdx = -1;
        for (let t = 0; t <= maxTier; t++) {
          const occ = occurrences(doc.lines, [chunk.anchor], t).filter((p) => p >= cursor);
          if (occ.length > 0) {
            foundIdx = occ[0]!;
            break;
          }
        }
        if (foundIdx < 0) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      if (chunk.o.length === 0) {
        const pos = chunk.eof ? doc.lines.length : cursor;
        const repl = chunk.n.map((x) => x.text);
        doc.lines.splice(pos, 0, ...repl);
        cursor = pos + repl.length;
      } else {
        let found: { tier: number; pos: number } | null = null;
        for (let t = 0; t <= maxTier; t++) {
          let occ = occurrences(doc.lines, chunk.o, t).filter((p) => p >= cursor);
          if (chunk.eof) occ = occ.filter((p) => p + chunk.o.length === doc.lines.length);
          if (occ.length > 0) {
            found = { tier: t, pos: occ[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', path);
        const repl = buildReplacement(chunk.n, doc.lines, found.pos, found.tier, chunk.o);
        doc.lines.splice(found.pos, chunk.o.length, ...repl);
        cursor = found.pos + repl.length;
      }
    }
    const text = renderFile(doc);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      movePairs.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

const V_ADD = '*** Add File: ';
const V_DELETE = '*** Delete File: ';
const V_UPDATE = '*** Update File: ';
const V_MOVE = '*** Move to: ';

function isSectionStart(line: string): boolean {
  return line.startsWith(V_ADD) || line.startsWith(V_DELETE) || line.startsWith(V_UPDATE);
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let j = first + 1;
  while (j < last) {
    const line = lines[j]!;
    if (blank(line)) {
      j += 1;
      continue;
    }
    if (!isSectionStart(line)) throw new Exit2(`error: parse ${j + 1}`);
    // The section's raw lines: until the next section start or `*** End Patch`,
    // with blank lines at the end dropped.
    let end = j + 1;
    while (end < last && !isSectionStart(lines[end]!)) end += 1;
    const raw = lines.slice(j + 1, end);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (line.startsWith(V_ADD)) {
      const addLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('+')) addLines.push(l.slice(1));
        else if (l === '') addLines.push('');
        else throw new Exit2(`error: parse ${j + 2 + k}`);
      }
      sections.push({ kind: 'add', path: line.slice(V_ADD.length).trim(), lines: addLines });
    } else if (line.startsWith(V_DELETE)) {
      if (raw.length > 0) throw new Exit2(`error: parse ${j + 2}`);
      sections.push({ kind: 'delete', path: line.slice(V_DELETE.length).trim() });
    } else {
      // Update File section.
      let moveTo: string | null = null;
      let k = 0;
      if (k < raw.length && raw[k]!.startsWith(V_MOVE)) {
        moveTo = raw[k]!.slice(V_MOVE.length).trim();
        k += 1;
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      let firstChunk = true;
      const closeChunk = (): void => {
        if (chunk !== null) {
          chunks.push(chunk);
          chunk = null;
        }
      };
      const startChunk = (anchor: string | null): void => {
        closeChunk();
        chunk = { anchor, eof: false, o: [], n: [] };
        firstChunk = false;
      };
      for (; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('@@')) {
          startChunk(l.slice(2).trim());
          continue;
        }
        if (l === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${j + 2 + k}`);
          chunk.eof = true;
          closeChunk();
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (chunk === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${j + 2 + k}`);
            chunk = { anchor: null, eof: false, o: [], n: [] };
            firstChunk = false;
          }
          if (l === '') {
            chunk.o.push('');
            chunk.n.push({ text: '', ctx: chunk.o.length - 1 });
          } else if (l[0] === ' ') {
            chunk.o.push(l.slice(1));
            chunk.n.push({ text: l.slice(1), ctx: chunk.o.length - 1 });
          } else if (l[0] === '-') {
            chunk.o.push(l.slice(1));
          } else {
            chunk.n.push({ text: l.slice(1), ctx: -1 });
          }
          continue;
        }
        throw new Exit2(`error: parse ${j + 2 + k}`);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${j + 1}`);
      sections.push({ kind: 'update', path: line.slice(V_UPDATE.length).trim(), moveTo, chunks });
    }
    j = end;
  }
  return sections.map((s) => v4aEdit(s, strict));
}

// ---------------------------------------------------------------------------
// Section 1, 2, 10: invocation, output, exit codes, order and atomicity.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const consumedOld = new Set<string>();
  const consumedNew = new Set<string>();
  for (const [oldP, newP] of movePairs) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumedOld.add(oldP);
      consumedNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (consumedOld.has(p) || consumedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
