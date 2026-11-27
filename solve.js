// diff-speed-01-run-20261126 — a faster drop-in for makefun-diff 1.0.0.
//
// Written from scratch for this entry from the rule the kit states (RULES.txt
// and baselines/makefun-diff/vendor/makefun-diff/index.js): tokenize on '\n',
// keep the common prefix then the common suffix, run Myers's greedy search
// between them (deletion wins ties, no edge pruning, snakes follow every run
// of equal lines), and print the same patch (3 kept lines of context, runs at
// most 6 kept lines apart share a hunk, '%' after a line with no newline).
// The output is byte-identical to makefun-diff 1.0.0 for every input; only the
// work is faster:
//
//   - Lines are interned to small integers once (one Map for both texts, so
//     equal lines share an id), and every comparison afterwards — prefix,
//     suffix, snakes — is an integer comparison instead of a string one.
//     A line's id carries whether it ends in '\n' (id even) or is a bare
//     last line (id odd), so no line string is built while tokenizing.
//   - The search runs on one flat Int32Array of V snapshots, reused across
//     cases, with no object allocated per diagonal: the reference builds a
//     linked path object per (d, k) step, which is most of its time on
//     20k-40k-line texts with ~4,000 edits. Each step reads one V value
//     (the other candidate is carried over from the previous diagonal) and
//     writes one.
//   - The snapshots are kept so the exact greedy path can be walked back;
//     the backtrack replays the same tie-break and the same validity guards
//     (a deletion needs an old line left, an insertion needs a new line
//     left), so the script it returns is the first path the reference's
//     search finds, not merely an equally short one.
//
// No dependencies, no I/O, no clock, no randomness: two runs on the same
// input write byte-identical output. MIT licensed (see LICENSE).

/** The patch's first word. */
const FORMAT = 'makefun-diff/1';

/** The kept lines a hunk shows before and after each change run. */
const CONTEXT = 3;

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/**
 * The V snapshots of the search, one flat buffer reused across cases in a
 * process: snapshot d starts at offset d*d (the snapshots before it hold
 * 1 + 3 + ... + (2d-1) = d*d entries) and holds 2d+1 entries, snapshot
 * d's entry for diagonal k at offset d*d + (k + d), the furthest x (old
 * lines consumed) on that diagonal after the snake, or -1 when the reference
 * leaves that diagonal undefined at that depth. Only the even offsets of a
 * snapshot are ever read, and every one of those is written on its depth,
 * so stale values in the reused buffer are never observed.
 */
let vbuf = new Int32Array(1 << 24);
function ensureVcap(need) {
  if (need <= vbuf.length) return;
  let cap = vbuf.length;
  while (cap < need) cap *= 2;
  const nb = new Int32Array(cap);
  nb.set(vbuf);
  vbuf = nb;
}

/**
 * Split a text into lines and intern each line to an integer id. A line is
 * its segment between '\n's; the id is twice the segment's interned number,
 * plus one when the line is the bare last line with no '\n'. `segs` is the
 * split's parts array, so line i is segs[i] and its id says whether it ends
 * in '\n'. Returns { ids, n, segs }.
 */
function tokenize(text, intern) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const ids = new Int32Array(parts.length);
  let w = 0;
  for (let i = 0; i < last; i++) {
    const seg = parts[i];
    let id = intern.get(seg);
    if (id === undefined) {
      id = intern.size;
      intern.set(seg, id);
    }
    ids[w++] = id * 2;
  }
  if (parts[last] !== '') {
    const seg = parts[last];
    let id = intern.get(seg);
    if (id === undefined) {
      id = intern.size;
      intern.set(seg, id);
    }
    ids[w++] = id * 2 + 1;
  }
  return { ids, n: w, segs: parts };
}

/**
 * The edit script of the middle slices aIds[p0..p0+N) into bIds[q0..q0+M),
 * as runs [{ kind, count }] in order — the exact script the reference's
 * greedy search finds first.
 */
function editRuns(aIds, p0, N, bIds, q0, M) {
  const maxD = N + M;
  // d = 0: the snake from (0, 0). (After the prefix trim the first lines
  // differ, so this is empty unless a side is empty; the code stays general.)
  let x = 0;
  let y = 0;
  while (x < N && y < M && aIds[p0 + x] === bIds[q0 + y]) {
    x++;
    y++;
  }
  vbuf[0] = x;
  if (x === N && y === M) return [];

  // Only diagonal k = N - M can reach both ends, so only it is checked.
  const kend = N - M;
  let D = -1;
  let kEnd = 0;
  outer: for (let d = 1; d <= maxD; d++) {
    ensureVcap((d + 1) * (d + 1));
    const basePrev = (d - 1) * (d - 1);
    const baseCur = d * d;
    const plen = 2 * d - 1;
    // The insertion candidate of diagonal k is the deletion candidate of
    // diagonal k + 2, so it is carried over instead of read twice.
    let vDel = -1; // no deletion candidate for k = -d
    let vIns = vbuf[basePrev]; // V_{d-1}[-d+1], the insertion candidate for k = -d
    for (let k = -d, ki = 0; k <= d; k += 2, ki += 2) {
      let nx = -1;
      // Deletion candidate: from diagonal k - 1. Valid when that diagonal
      // exists and an old line is left to delete (vDel < N); it reaches
      // x = vDel + 1.
      if (vDel !== -1 && vDel < N) nx = vDel + 1;
      // Insertion candidate: from diagonal k + 1. Valid when that diagonal
      // exists and a new line is left to insert (vIns - (k + 1) < M); it
      // keeps x = vIns, and replaces the deletion only when strictly
      // further: the deletion wins ties.
      if (vIns !== -1 && vIns - k - 1 < M && vIns > nx) nx = vIns;
      if (nx === -1) {
        vbuf[baseCur + ki] = -1;
      } else {
        let ny = nx - k;
        while (nx < N && ny < M && aIds[p0 + nx] === bIds[q0 + ny]) {
          nx++;
          ny++;
        }
        vbuf[baseCur + ki] = nx;
        if (k === kend && nx === N) {
          D = d;
          kEnd = k;
          break outer;
        }
      }
      vDel = vIns;
      vIns = ki + 2 < plen ? vbuf[basePrev + ki + 2] : -1;
    }
  }
  if (D === -1) throw new Error('makefun-diff: the search ended without reaching both ends');

  // Walk the exact greedy path back from (D, kEnd): at each depth the edit
  // is the one the forward step chose, replayed with the same tie-break
  // and the same validity guards.
  const rev = [];
  let k = kEnd;
  for (let d = D; d >= 1; d--) {
    const basePrev = (d - 1) * (d - 1);
    const curX = vbuf[d * d + (k + d)];
    let xDel = -1;
    let xIns = -1;
    const ri = k + d - 2;
    if (ri >= 0 && ri < 2 * d - 1) {
      const v = vbuf[basePrev + ri];
      if (v !== -1 && v < N) xDel = v + 1;
    }
    const ai = k + d;
    if (ai >= 0 && ai < 2 * d - 1) {
      const v = vbuf[basePrev + ai];
      if (v !== -1 && v - (k + 1) < M) xIns = v;
    }
    if (xDel !== -1 && (xIns === -1 || xDel >= xIns)) {
      // Deletion: the snake after it ran from (xDel, xDel - k) to (curX, curX - k).
      if (curX > xDel) rev.push({ kind: KEEP, count: curX - xDel });
      rev.push({ kind: DELETE, count: 1 });
      k = k - 1;
    } else if (xIns !== -1) {
      // Insertion: the snake after it ran from (xIns, xIns - k) to (curX, curX - k).
      if (curX > xIns) rev.push({ kind: KEEP, count: curX - xIns });
      rev.push({ kind: INSERT, count: 1 });
      k = k + 1;
    } else {
      throw new Error('makefun-diff: the backtrack found no edit');
    }
  }
  // The d = 0 snake, from (0, 0) to (vbuf[0], vbuf[0]).
  if (vbuf[0] > 0) rev.push({ kind: KEEP, count: vbuf[0] });
  rev.reverse();
  // The reference merges consecutive edits of one kind (its addToPath does);
  // the backtrack emits them one per depth, so merge them here.
  const runs = [];
  for (const r of rev) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else runs.push({ kind: r.kind, count: r.count });
  }
  return runs;
}

/**
 * A line as the patch writes it: its op, the segment, a newline, and '%'
 * on a line of its own when the line had none (an odd id).
 */
function written(op, seg, id) {
  return (id & 1) === 0 ? `${op}${seg}\n` : `${op}${seg}\n%\n`;
}

/** make.fun's own patch of input.old into input.new, as makefun-diff 1.0.0 returns it. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const intern = new Map();
  const a = tokenize(input.old, intern);
  const b = tokenize(input.new, intern);
  const n = a.n;
  const m = b.n;
  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a.ids[prefix] === b.ids[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a.ids[n - 1 - suffix] === b.ids[m - 1 - suffix]) suffix++;
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  const mid = editRuns(a.ids, prefix, n - prefix - suffix, b.ids, prefix, m - prefix - suffix);
  for (const r of mid) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else runs.push({ kind: r.kind, count: r.count });
  }
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', a.segs[at], a.ids[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', a.segs[c.o + i], a.ids[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', b.segs[c.p + i], b.ids[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', a.segs[at], a.ids[at]));
  }
  return out.join('');
}
