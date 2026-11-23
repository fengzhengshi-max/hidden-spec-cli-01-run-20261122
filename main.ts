// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** A file split into lines: its break, its lines, and whether it ends with a break. */
interface Split {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, final: fin };
}

function joinFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

/** Only spaces and tabs count as whitespace for matching (SPEC.md section 5). */
const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

/** 0-based starts where O matches `lines` at `tier`, from `from` on; overlaps count. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) with an occurrence at/after `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own line at oIdx) or a new line. */
interface NLine {
  text: string;
  ctx: number | null;
  bs: boolean; // a `\` line follows this body line
}

/** Render N at `at`: context lines as the file's own, tier 2 re-indents the rest. */
function renderN(n: NLine[], fileLines: string[], at: number, tier: number, oFirst: string): string[] {
  if (tier !== 2) return n.map((l) => (l.ctx === null ? l.text : fileLines[at + l.ctx]!));
  const p = leadST(oFirst);
  const f = leadST(fileLines[at] ?? '');
  return n.map((l) => {
    if (l.ctx !== null) return fileLines[at + l.ctx]!;
    const t = l.text;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

/** One unified hunk: A is the old start (1-based); O the context+`-` lines. */
interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  lastNoNl: boolean; // a `\` line follows the hunk's last context or `+` line
}

interface Section {
  hdrOld: string | null | undefined;
  hdrNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function parsePath4(line: string): string {
  const t = line.slice(4);
  const tab = t.indexOf('\t');
  return (tab >= 0 ? t.slice(0, tab) : t).trim();
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function diffGitPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
  return m ? [m[1]!, m[2]!] : null;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function pick3(a: string | null | undefined, b: string | undefined, c: string | undefined): string | null {
  if (a !== undefined) return a;
  if (b !== undefined) return b;
  return c ?? null;
}

/** Apply one hunk to the working lines; d is the offset from hunks applied so far. */
function applyHunk(lines: string[], fin: boolean, h: Hunk, d: number, strict: boolean, path: string): { lines: string[]; final: boolean } {
  if (h.o.length === 0) {
    const ins = Math.min(Math.max(h.a + d, 0), lines.length);
    const added = h.n.map((l) => l.text);
    const out = [...lines.slice(0, ins), ...added, ...lines.slice(ins)];
    let f = fin;
    if (ins === lines.length && added.length > 0) f = !h.lastNoNl;
    return { lines: out, final: f };
  }
  const found = findTier(lines, h.o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  for (const p of found.occ) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const added = renderN(h.n, lines, best, found.tier, h.o[0]!);
  const out = [...lines.slice(0, best), ...added, ...lines.slice(best + h.o.length)];
  let f = fin;
  if (best + h.o.length === lines.length) f = h.n.length === 0 ? true : !h.lastNoNl;
  return { lines: out, final: f };
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const s = splitFile(text);
  let lines = s.lines;
  let fin = s.final;
  let d = 0;
  for (const h of hunks) {
    const r = applyHunk(lines, fin, h, d, strict, path);
    lines = r.lines;
    fin = r.final;
    d += h.n.length - h.o.length;
  }
  return joinFile(lines, s.br, fin);
}

/** Parse a unified patch (SPEC.md section 6) into one edit per section. */
function unifiedEdits(lines: string[], moves: Array<{ from: string; to: string }>, strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hasPair = false;
  const startSection = (gitOld: string | undefined, gitNew: string | undefined): void => {
    cur = { hdrOld: undefined, hdrNew: undefined, renOld: undefined, renNew: undefined, gitOld, gitNew, create: false, del: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
    hasPair = false;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const g = diffGitPaths(line);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(g[0], g[1]);
      i++;
      continue;
    }
    const nextIsPlusPlus = (lines[i + 1] ?? '').startsWith('+++ ');
    if (line.startsWith('--- ') && nextIsPlusPlus) {
      if (cur !== null && inHeader && !hasPair) {
        const p = parsePath4(line);
        cur.hdrOld = p === '/dev/null' ? null : stripAB(p);
        const q = parsePath4(lines[i + 1]!);
        cur.hdrNew = q === '/dev/null' ? null : stripAB(q);
        hasPair = true;
        i += 2;
        continue;
      }
      startSection(undefined, undefined);
      const p = parsePath4(line);
      cur!.hdrOld = p === '/dev/null' ? null : stripAB(p);
      const q = parsePath4(lines[i + 1]!);
      cur!.hdrNew = q === '/dev/null' ? null : stripAB(q);
      hasPair = true;
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        cur.renOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const m = HUNK_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        inHeader = false;
        i = readHunk(lines, i, Number(m[1]), cur);
        continue;
      }
      i++;
      continue;
    }
    if (cur !== null && line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      i = readHunk(lines, i, Number(m[1]), cur);
      continue;
    }
    if (cur === null && line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  return sections.map((s) => sectionEdit(s, moves, strict));
}

/** Read the hunk at header index `h` into `section`; returns the index after its body. */
function readHunk(lines: string[], h: number, a: number, section: Section): number {
  interface Body {
    kind: 'ctx' | 'old' | 'new';
    text: string;
    bs: boolean;
    empty: boolean;
  }
  const body: Body[] = [];
  let j = h + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '', bs: false, empty: true });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1), bs: false, empty: false });
      j++;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1), bs: false, empty: false });
      j++;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: l.slice(1), bs: false, empty: false });
      j++;
      continue;
    }
    if (c === '\\') {
      if (body.length > 0) body[body.length - 1]!.bs = true;
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.empty) body.pop();
    else break;
  }
  const o: string[] = [];
  const n: NLine[] = [];
  let lastNoNl = false;
  for (const e of body) {
    if (e.kind === 'ctx') {
      o.push(e.text);
      n.push({ text: e.text, ctx: o.length - 1, bs: e.bs });
      lastNoNl = e.bs;
    } else if (e.kind === 'old') {
      o.push(e.text);
    } else {
      n.push({ text: e.text, ctx: null, bs: e.bs });
      lastNoNl = e.bs;
    }
  }
  section.hunks.push({ a, o, n, lastNoNl });
  return j;
}

function sectionEdit(s: Section, moves: Array<{ from: string; to: string }>, strict: boolean): Edit {
  return (tree) => {
    const oldP = pick3(s.hdrOld, s.renOld, s.gitOld);
    const newP = pick3(s.hdrNew, s.renNew, s.gitNew);
    const isCreate = oldP === null || s.create;
    const isDelete = !isCreate && (newP === null || s.del);
    if (isCreate) {
      const np = newP as string;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let fin = true;
      for (const h of s.hunks) {
        for (const l of h.n) {
          if (l.ctx === null) {
            plus.push(l.text);
            fin = !l.bs;
          }
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const op = oldP as string;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP as string;
    const np = newP as string;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    const isMove = op !== np;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    const out = applyHunks(before, s.hunks, strict, op);
    if (isMove) {
      tree.now.set(np, out);
      tree.now.set(op, null);
      moves.push({ from: op, to: np });
    } else {
      tree.now.set(op, out);
    }
  };
}

/** Parse SEARCH/REPLACE blocks (SPEC.md section 7) into edits. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let e = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        e = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (e < 0) throw new Exit2(`error: parse ${s + 1}`);
    let r = -1;
    for (let j = e + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        r = j;
        break;
      }
    }
    if (r < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, e);
    const newLines = lines.slice(e + 1, r);
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    prevPath = path;
    prevEnd = r;
    edits.push(srEdit(path, oldLines, newLines, strict));
    i = r + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const s = splitFile(text);
    const found = findTier(s.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const nLines = renderN(
      newLines.map((t) => ({ text: t, ctx: null, bs: false })),
      s.lines,
      at,
      found.tier,
      oldLines[0]!,
    );
    const out = [...s.lines.slice(0, at), ...nLines, ...s.lines.slice(at + oldLines.length)];
    tree.now.set(path, joinFile(out, s.br, s.final));
  };
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: Array<{ kind: 'ctx' | 'old' | 'new'; text: string; blank: boolean }>;
  byAt: boolean; // started by an @@ line (kept even when its body strips empty)
}

/** Parse a V4A patch (SPEC.md section 8) into edits. */
function v4aEdits(lines: string[], moves: Array<{ from: string; to: string }>, strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        const l = lines[j]!;
        if (l === '') {
          raw.push('');
          j++;
          continue;
        }
        if (l.startsWith('+')) {
          raw.push(l.slice(1));
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      edits.push(vAddEdit(path, raw));
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        if (blank(lines[j]!)) {
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push(vDeleteEdit(path));
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let chunkCount = 0;
      const closeChunk = (): void => {
        if (cur === null) return;
        while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.blank) cur.body.pop();
        if (cur.body.length > 0 || cur.byAt) chunks.push(cur);
        cur = null;
      };
      while (j < last) {
        const l = lines[j]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('@@')) {
          closeChunk();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [], byAt: true };
          chunkCount++;
          j++;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          closeChunk();
          j++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunkCount > 0) throw new Exit2(`error: parse ${j + 1}`);
            cur = { anchor: null, eof: false, body: [], byAt: false };
            chunkCount++;
          }
          cur.body.push({
            kind: l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new',
            text: l === '' ? '' : l.slice(1),
            blank: l.trim() === '',
          });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(vUpdateEdit(path, moveTo, chunks, moves, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function vAddEdit(path: string, rawLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, rawLines.length === 0 ? '' : rawLines.join('\n') + '\n');
  };
}

function vDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], moves: Array<{ from: string; to: string }>, strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const s = splitFile(text);
    let lines = s.lines;
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        let foundAt: number | null = null;
        for (const t of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < lines.length; k++) {
            if (lineEq(lines[k]!, c.anchor, t)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const o: string[] = [];
      const n: NLine[] = [];
      for (const e of c.body) {
        if (e.kind === 'ctx') {
          o.push(e.text);
          n.push({ text: e.text, ctx: o.length - 1, bs: false });
        } else if (e.kind === 'old') {
          o.push(e.text);
        } else {
          n.push({ text: e.text, ctx: null, bs: false });
        }
      }
      if (o.length === 0) {
        const ins = c.eof ? lines.length : cursor;
        const added = n.map((l) => l.text);
        lines = [...lines.slice(0, ins), ...added, ...lines.slice(ins)];
        cursor = ins + added.length;
      } else {
        let hit: { tier: number; at: number } | null = null;
        for (const t of strict ? [0] : [0, 1, 2]) {
          const occ = occurrences(lines, o, t, cursor);
          const ok = c.eof ? occ.filter((p) => p + o.length === lines.length) : occ;
          if (ok.length > 0) {
            hit = { tier: t, at: ok[0]! };
            break;
          }
        }
        if (hit === null) throw new Fail('no-match', path);
        const added = renderN(n, lines, hit.at, hit.tier, o[0]!);
        lines = [...lines.slice(0, hit.at), ...added, ...lines.slice(hit.at + o.length)];
        cursor = hit.at + added.length;
      }
    }
    const out = joinFile(lines, s.br, s.final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push({ from: path, to: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

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
  const moves: Array<{ from: string; to: string }> = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, moves, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, moves, strict);
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
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move qualifies for an R line when its old path existed before the patch and
  // does not after it, and its new path did not exist before it and does after it.
  const rPairs = moves.filter((m) => {
    const wasFrom = tree.original(m.from);
    const nowFrom = tree.get(m.from);
    const wasTo = tree.original(m.to);
    const nowTo = tree.get(m.to);
    return wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null;
  });
  const rFrom = new Set(rPairs.map((m) => m.from));
  const rTo = new Map(rPairs.map((m) => [m.to, m.from] as [string, string]));
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rFrom.has(p)) continue; // replaced by the R line, which sorts by its new path
    if (rTo.has(p)) rows.push(`R ${rTo.get(p)} -> ${p}`);
    else rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
