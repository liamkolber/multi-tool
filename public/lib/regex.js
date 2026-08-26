// Regex: building one, inferring one from examples, and explaining one.
//
// Kept apart from the panel that renders it because this is the part with real
// logic in it — it can be imported and tested directly, which UI code cannot.
// Nothing here touches the DOM.

// --- Escaping ---------------------------------------------------------------
export function escapeLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// Inside [...] only these four actually need escaping, and over-escaping makes
// the result unreadable.
function escapeClass(s) {
  return String(s).replace(/[\]\\^-]/g, '\\$&');
}

// --- Building ---------------------------------------------------------------
// A part is { kind, value, quant, min, max, group, name }. Order matters; the
// pattern is the parts concatenated.

const ATOMS = {
  digit: { re: '\\d', label: 'a digit', plural: 'digits' },
  notdigit: { re: '\\D', label: 'a non-digit', plural: 'non-digits' },
  letter: { re: '[A-Za-z]', label: 'a letter', plural: 'letters' },
  word: { re: '\\w', label: 'a word character', plural: 'word characters' },
  notword: { re: '\\W', label: 'a non-word character', plural: 'non-word characters' },
  space: { re: '\\s', label: 'whitespace', plural: 'whitespace' },
  notspace: { re: '\\S', label: 'a non-whitespace character', plural: 'non-whitespace characters' },
  any: { re: '.', label: 'any character', plural: 'any characters' },
  start: { re: '^', label: 'start of the line', anchor: true },
  end: { re: '$', label: 'end of the line', anchor: true },
  boundary: { re: '\\b', label: 'a word boundary', anchor: true },
};

// A quantifier binds to the single token before it, so anything longer than one
// token has to be wrapped first or "abc+" only repeats the c.
function needsWrap(re) {
  if (re.length <= 1) return false;
  if (/^\\[dDwWsSbB]$/.test(re)) return false;              // \d, \w, …
  if (/^\\.$/.test(re)) return false;                        // an escaped literal
  if (/^\[[^\]]*\]$/.test(re)) return false;                 // a character class
  if (/^\((?:\?[:=!<][^)]*|[^)]*)\)$/.test(re)) return false; // already a group
  return true;
}

function applyQuant(re, part) {
  const q = part.quant || 'one';
  if (q === 'one') return re;
  const base = needsWrap(re) ? `(?:${re})` : re;
  switch (q) {
    case 'optional': return `${base}?`;
    case 'many': return `${base}+`;
    case 'any': return `${base}*`;
    case 'exactly': return `${base}{${Math.max(0, Number(part.min) || 0)}}`;
    case 'atleast': return `${base}{${Math.max(0, Number(part.min) || 0)},}`;
    case 'between': {
      const lo = Math.max(0, Number(part.min) || 0);
      const hi = Math.max(lo, Number(part.max) || lo);
      return `${base}{${lo},${hi}}`;
    }
    default: return re;
  }
}

function partAtom(part) {
  const kind = part.kind;
  if (ATOMS[kind]) return ATOMS[kind].re;
  const value = part.value == null ? '' : String(part.value);
  if (kind === 'literal') return escapeLiteral(value);
  if (kind === 'set') return `[${escapeClass(value)}]`;
  if (kind === 'notset') return `[^${escapeClass(value)}]`;
  if (kind === 'oneof') {
    const opts = value.split('|').map((s) => s.trim()).filter(Boolean).map(escapeLiteral);
    if (!opts.length) return '';
    return `(?:${opts.join('|')})`;
  }
  if (kind === 'raw') return value; // an escape hatch for hand-written fragments
  return '';
}

export function buildPattern(parts) {
  return (parts || []).map((part) => {
    let re = partAtom(part);
    if (!re) return '';
    // Anchors can't be quantified or grouped meaningfully.
    if (ATOMS[part.kind] && ATOMS[part.kind].anchor) return re;
    re = applyQuant(re, part);
    if (part.group === 'capture') re = `(${re})`;
    else if (part.group === 'named' && part.name) re = `(?<${part.name.replace(/[^A-Za-z0-9_]/g, '')}>${re})`;
    return re;
  }).join('');
}

// --- Inferring from examples -------------------------------------------------
// Splits each sample into runs of one character category, then generalises
// position by position. It is deliberately literal about separators: in
// "AB-1234" the dash is structure, not something to guess about.

const CATEGORY = [
  { id: 'digits', test: /[0-9]/, re: '\\d' },
  { id: 'lower', test: /[a-z]/, re: '[a-z]' },
  { id: 'upper', test: /[A-Z]/, re: '[A-Z]' },
  { id: 'space', test: /\s/, re: '\\s' },
];

function categorise(ch) {
  for (const c of CATEGORY) if (c.test.test(ch)) return c.id;
  return 'other';
}

function tokenise(s) {
  const out = [];
  for (const ch of String(s)) {
    const cat = categorise(ch);
    const last = out[out.length - 1];
    if (last && last.cat === cat) last.text += ch;
    else out.push({ cat, text: ch });
  }
  return out;
}

// Letters that vary in case between samples become [A-Za-z] rather than two
// alternatives, which is nearly always what was meant.
function mergeCats(cats) {
  const set = new Set(cats);
  if (set.size === 1) return [...set][0];
  if (set.size === 2 && set.has('lower') && set.has('upper')) return 'letters';
  return null;
}

const CAT_RE = {
  digits: '\\d', lower: '[a-z]', upper: '[A-Z]', letters: '[A-Za-z]', space: '\\s',
};

export function inferPattern(samples, opts = {}) {
  const lines = (samples || [])
    .map((s) => String(s).trim())
    .filter(Boolean);

  if (!lines.length) return { pattern: '', note: 'Add at least one example.' };

  const tokenised = lines.map(tokenise);
  const width = tokenised[0].length;
  const sameShape = tokenised.every((t) => t.length === width);

  if (!sameShape) {
    // Nothing structural in common, so the honest answer is an alternation of
    // the examples themselves rather than a guess that matches too much.
    const alts = [...new Set(lines)].map(escapeLiteral);
    return {
      pattern: `${opts.anchor === false ? '' : '^'}(?:${alts.join('|')})${opts.anchor === false ? '' : '$'}`,
      note: 'The examples do not share a structure, so this matches them literally. Examples of the same shape produce a general pattern.',
    };
  }

  // Each column becomes { re, lo, hi }; literals carry lo/hi of null so they are
  // never merged into a count.
  const cols = [];
  for (let i = 0; i < width; i++) {
    const col = tokenised.map((t) => t[i]);
    const cat = mergeCats(col.map((t) => t.cat));
    const texts = col.map((t) => t.text);
    const lengths = texts.map((t) => t.length);
    const lo = Math.min(...lengths);
    const hi = Math.max(...lengths);

    // A separator identical everywhere is structure — keep it verbatim.
    if (cat === 'other' || !CAT_RE[cat]) {
      const same = new Set(texts);
      if (same.size === 1) { cols.push({ re: escapeLiteral(texts[0]), literal: true }); continue; }
      const chars = [...new Set(texts.join(''))].join('');
      cols.push({ re: `[${escapeClass(chars)}]`, lo: lo === hi ? lo : lo, hi: hi === lo ? hi : Infinity });
      continue;
    }
    cols.push({ re: CAT_RE[cat], lo, hi });
  }

  // Tokenising splits "Ab" into an upper run and a lower run, which both
  // generalise to [A-Za-z] and would otherwise emit "[A-Za-z][A-Za-z]". Folding
  // neighbours that produced the same atom gives "[A-Za-z]{2}".
  const merged = [];
  for (const c of cols) {
    const prev = merged[merged.length - 1];
    if (prev && !prev.literal && !c.literal && prev.re === c.re) {
      prev.lo += c.lo;
      prev.hi += c.hi;
      continue;
    }
    merged.push({ ...c });
  }

  const parts = merged.map((c) => {
    if (c.literal) return c.re;
    if (!Number.isFinite(c.hi)) return `${c.re}+`;
    if (c.lo === c.hi) return c.lo === 1 ? c.re : `${c.re}{${c.lo}}`;
    return `${c.re}{${c.lo},${c.hi}}`;
  });

  const body = parts.join('');
  const anchored = opts.anchor === false ? body : `^${body}$`;
  return {
    pattern: anchored,
    note: lines.length === 1
      ? 'Inferred from a single example — add more so it can tell what varies.'
      : `Inferred from ${lines.length} examples.`,
  };
}

// --- Explaining --------------------------------------------------------------
// Walks the pattern and describes each token in order. A flat list rather than a
// tree: the point is to read what it does, not to reconstruct the parse.

const QUANT_WORDS = {
  '*': 'zero or more times',
  '+': 'one or more times',
  '?': 'optionally',
};

function readQuant(pattern, i) {
  const ch = pattern[i];
  if (ch === '*' || ch === '+' || ch === '?') {
    const lazy = pattern[i + 1] === '?';
    return { text: QUANT_WORDS[ch] + (lazy ? ', as few as possible' : ''), length: lazy ? 2 : 1 };
  }
  if (ch === '{') {
    const close = pattern.indexOf('}', i);
    if (close < 0) return null;
    const body = pattern.slice(i + 1, close);
    const m = body.match(/^(\d+)(,(\d*)?)?$/);
    if (!m) return null;
    const lazy = pattern[close + 1] === '?';
    let text;
    if (!m[2]) text = `exactly ${m[1]} time${m[1] === '1' ? '' : 's'}`;
    else if (!m[3]) text = `${m[1]} or more times`;
    else text = `between ${m[1]} and ${m[3]} times`;
    return { text: text + (lazy ? ', as few as possible' : ''), length: close - i + 1 + (lazy ? 1 : 0) };
  }
  return null;
}

const ESCAPES = {
  d: 'a digit', D: 'a non-digit', w: 'a word character', W: 'a non-word character',
  s: 'whitespace', S: 'a non-whitespace character', b: 'a word boundary',
  B: 'a position that is not a word boundary', n: 'a newline', t: 'a tab', r: 'a carriage return',
};

export function explainPattern(pattern) {
  const src = String(pattern || '');
  if (!src) return [];
  const out = [];
  let i = 0;

  const push = (text) => {
    // A quantifier belongs to the thing it follows, so fold it into that line.
    const q = readQuant(src, i);
    if (q) { i += q.length; out.push(`${text}, ${q.text}`); }
    else out.push(text);
  };

  while (i < src.length) {
    const ch = src[i];

    if (ch === '\\') {
      const next = src[i + 1];
      i += 2;
      push(ESCAPES[next] || `the literal character "${next}"`);
      continue;
    }

    if (ch === '[') {
      let j = i + 1;
      const negated = src[j] === '^';
      if (negated) j++;
      let body = '';
      while (j < src.length && src[j] !== ']') {
        if (src[j] === '\\') { body += src[j] + src[j + 1]; j += 2; continue; }
        body += src[j];
        j++;
      }
      i = j + 1;
      push(`${negated ? 'any character except' : 'any of'} ${describeClass(body)}`);
      continue;
    }

    if (ch === '(') {
      let text = 'the start of a group';
      if (src.startsWith('(?:', i)) { text = 'the start of a group (not captured)'; i += 3; }
      else if (src.startsWith('(?=', i)) { text = 'a check that what follows matches'; i += 3; }
      else if (src.startsWith('(?!', i)) { text = 'a check that what follows does NOT match'; i += 3; }
      else if (src.startsWith('(?<=', i)) { text = 'a check that what precedes matches'; i += 4; }
      else if (src.startsWith('(?<!', i)) { text = 'a check that what precedes does NOT match'; i += 4; }
      else {
        const named = src.slice(i).match(/^\(\?<([A-Za-z0-9_]+)>/);
        if (named) { text = `the start of a group captured as "${named[1]}"`; i += named[0].length; }
        else { text = 'the start of a captured group'; i += 1; }
      }
      out.push(text);
      continue;
    }

    if (ch === ')') { i += 1; push('the end of that group'); continue; }
    if (ch === '|') { i += 1; out.push('— or —'); continue; }
    if (ch === '^') { i += 1; out.push('the start of the line'); continue; }
    if (ch === '$') { i += 1; out.push('the end of the line'); continue; }
    if (ch === '.') { i += 1; push('any character'); continue; }

    // A run of plain literal characters reads better as one line than as one
    // line per character — but only up to the last one, which a quantifier
    // would bind to on its own.
    let run = '';
    while (i < src.length && !'\\[](){}|^$.*+?'.includes(src[i])) { run += src[i]; i++; }

    // Every metacharacter above is excluded from that run, so a malformed
    // pattern that leaves one stranded — a lone "{", "a{" with no closing
    // brace, a leading "*" — would collect nothing, advance nothing, and spin
    // forever. Consuming it as a literal guarantees the walk terminates.
    if (!run) {
      run = src[i];
      i += 1;
      out.push(`a stray "${run}"`);
      continue;
    }

    if (run.length > 1 && readQuant(src, i)) {
      const last = run.slice(-1);
      out.push(`the text "${run.slice(0, -1)}"`);
      run = last;
    }
    push(`the text "${run}"`);
  }

  return out;
}

function describeClass(body) {
  const parts = [];
  const ranges = body.match(/(\\.|[^\\])-(\\.|[^\\])/g) || [];
  let rest = body;
  for (const r of ranges) {
    rest = rest.replace(r, '');
    parts.push(`${r[0]} to ${r[r.length - 1]}`);
  }
  const singles = rest.replace(/\\/g, '');
  if (singles) parts.push(`"${singles}"`);
  return parts.join(', ') || 'nothing';
}
