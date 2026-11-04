#!/usr/bin/env node
/**
 * Offline mixing from Logic's exported tracks (File › Export › All Tracks as Audio Files, Volume/Pan Automation
 * off, so each file is the track after its insert plugins and before its fader and pan). The mix is rebuilt here
 * with faders, pans and Channel EQs, so the fix search runs locally and Logic only gets the final moves.
 *
 *   node tools/stem-mix.mjs init <stems dir> --session sessions/<slug>
 *       Writes <session>/stems/plan.json with one entry per file. Fill in fader, pan, mute and instrument
 *       from the session's track map before the next step.
 *   node tools/stem-mix.mjs match --session sessions/<slug> --baseline <Logic's mix bounce>
 *       Rebuilds the current mix and compares it with Logic's own bounce. Do not trust optimize until this passes.
 *   node tools/stem-mix.mjs optimize --session sessions/<slug> --ref <reference> [--genre rock] [--target streaming]
 *                                    [--max-fader 6] [--no-eq] [--prefix "AE PR14"]
 *       Searches fader, EQ and pan moves on a fast linear model, verifies the result with a real render and the
 *       analyzer, and writes <session>/stems/plan-next.json plus the Logic apply list (apply.txt).
 *   node tools/stem-mix.mjs render --session sessions/<slug> [--plan plan-next.json] [--ref ref] [--out mix.wav]
 *       Renders a plan and prints the compact analysis.
 *   node tools/stem-mix.mjs presets --session sessions/<slug> [--plan plan-next.json]
 *       Writes the plan's new Channel EQ presets into Logic's Audio Engineer preset folder.
 *
 * Plan entries: { name, file, instrument, fader (dB), pan (−64…+63), mute, eq }, where eq is null,
 * { preset: "AE PR13 Drum" } or { name: "AE PR14 Drum", bands: ["lowCut:50:24", "peak:60:-6:1.2", "highShelf:8000:-5"] }.
 * plan.stemMode is "pre-fader" (default, files exclude fader and pan) or "post-fader" (files include both).
 * plan.stereoOutGainDb is a Gain plug-in on the Stereo Out (mix stage headroom).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PRESET_DIR, core, decode, parseFlags } from './lib.mjs';

const { analyze } = await core('analyze.js');
const { evaluate, bandDeviations } = await core('evaluate.js');
const { measureSpectrum } = await core('spectrum.js');
const { BANDS, THIRD_OCTAVES, THRESHOLDS } = await core('profiles.js');
const { eqSections, eqResponse } = await core('eq/response.js');
const { applySections } = await core('dsp/biquad.js');
const { BAND_KEYS, PEAK_KEYS, flatEq, cloneEq, normalizeEq, eqLines, buildEq } = await core('eq/channel-eq.js');
const { encodeChannelEq, decodeChannelEq, presetFileName } = await core('eq/pst.js');

const flags = parseFlags(process.argv.slice(2), { booleans: ['no-eq', 'json', 'dry-run'] });
const [command, arg] = flags._;
const sessionDir = flags.session ? resolve(flags.session) : null;
const stemsDir = sessionDir ? join(sessionDir, 'stems') : null;
const AUDIO = new Set(['.wav', '.aif', '.aiff', '.caf', '.flac']);
const r1 = (x) => Math.round(x * 10) / 10;
const sgn = (x) => `${x > 0 ? '+' : ''}${r1(x).toFixed(1)}`;
const dbToGain = (db) => 10 ** (db / 20);

function need(cond, msg) { if (!cond) { console.error(msg); process.exit(1); } }

/* ---------------- plan ---------------- */

function loadPlan(file = 'plan.json') {
  const path = resolve(stemsDir, file);
  need(existsSync(path), `No plan at ${path}. Run: node tools/stem-mix.mjs init <stems dir> --session ${flags.session}`);
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  plan.stemMode ??= 'pre-fader';
  plan.stereoOutGainDb ??= 0;
  for (const t of plan.tracks) { t.fader ??= 0; t.pan ??= 0; t.mute ??= false; t.eq ??= null; }
  return plan;
}

const presetCache = new Map();
function presetEq(name) {
  if (!presetCache.has(name)) {
    const path = join(PRESET_DIR, presetFileName(name));
    need(existsSync(path), `Preset not found: ${path}`);
    presetCache.set(name, decodeChannelEq(readFileSync(path)).eq);
  }
  return presetCache.get(name);
}

const TYPES = new Set(['lowCut', 'highCut', 'lowShelf', 'highShelf', 'peak']);
function parseBand(spec) {
  const [type, freq, third, q] = spec.split(':');
  need(TYPES.has(type), `Unknown band type in ${spec}`);
  if (type.endsWith('Cut')) return { type, freq: Number(freq), slope: Number(third ?? 12), q: Number(q ?? 0.71) };
  return { type, freq: Number(freq), gain: Number(third), q: Number(q ?? (type === 'peak' ? 1 : 0.71)) };
}

/** The Channel EQ a plan entry describes, or null. Several AE EQs can be stacked: eq may be an array. */
function eqsOf(entry) {
  const list = Array.isArray(entry) ? entry : entry ? [entry] : [];
  return list.map((e) => (e.preset ? presetEq(e.preset) : normalizeEq(buildEq(e.bands.map(parseBand), { maxGain: 24 }).eq)));
}

/** Band specs for make-preset.mjs from an EQ model. */
function eqSpecs(eq) {
  const out = [];
  for (const key of BAND_KEYS) {
    const b = eq.bands[key];
    if (!b.on) continue;
    const kind = key === 'lowCut' || key === 'highCut' ? key : key === 'lowShelf' || key === 'highShelf' ? key : 'peak';
    if (kind.endsWith('Cut')) out.push(`${kind}:${Math.round(b.freq)}:${b.slope}${b.q !== 0.71 ? `:${b.q}` : ''}`);
    else if (b.gain) out.push(`${kind}:${Math.round(b.freq)}:${r1(b.gain)}:${Math.round(b.q * 100) / 100}`);
  }
  return out;
}

/* ---------------- pan law ---------------- */

/** Logic's default −3 dB compensated pan law: 0 dB at centre. Mono sources pan; stereo sources balance. */
function panGains(pan, mono) {
  const th = ((Math.max(-64, Math.min(63, pan)) + 64) / 128) * (Math.PI / 2);
  const l = Math.SQRT2 * Math.cos(th), r = Math.SQRT2 * Math.sin(th);
  if (mono) return [l, r];
  return pan <= 0 ? [1, r] : [l, 1];
}

/** Channel gains a plan entry applies to its file. */
function trackGains(t, base, plan, mono) {
  if (t.mute) return [0, 0];
  const g = dbToGain(t.fader);
  const [l, r] = panGains(t.pan, mono);
  if (plan.stemMode !== 'post-fader') return [g * l, g * r];
  // The file already includes the exported fader and pan: apply only the change.
  const g0 = dbToGain(base.fader);
  const [l0, r0] = panGains(base.pan, mono);
  const ratio = (a, b) => (b < 1e-3 ? (a < 1e-3 ? 0 : NaN) : a / b);
  const out = [g / g0 * ratio(l, l0), g / g0 * ratio(r, r0)];
  need(out.every(Number.isFinite), `${t.name}: can't move pan away from hard ${base.pan < 0 ? 'left' : 'right'} with post-fader files.`);
  return out;
}

/* ---------------- audio ---------------- */

const audioCache = new Map();
function stemAudio(plan, t) {
  const file = resolve(plan.stemsDir, t.file);
  if (!audioCache.has(file)) {
    const { channels, sampleRate } = decode(file);
    const mono = channels.length === 1 || isDualMono(channels);
    audioCache.set(file, { channels: mono ? [channels[0]] : channels, sampleRate, mono });
  }
  return audioCache.get(file);
}

function isDualMono([L, R]) {
  if (!R) return true;
  for (let i = 0; i < L.length; i += 7) if (Math.abs(L[i] - R[i]) > 1e-6) return false;
  return true;
}

/** Sums the plan into a stereo mix, as Logic's Stereo Out would before its plug-ins. */
function render(plan, base) {
  const auds = plan.tracks.map((t) => stemAudio(plan, t));
  const fs = auds[0].sampleRate;
  need(auds.every((a) => a.sampleRate === fs), 'Exported tracks have different sample rates.');
  const n = Math.max(...auds.map((a) => a.channels[0].length));
  const mix = [new Float32Array(n), new Float32Array(n)];
  plan.tracks.forEach((t, i) => {
    const a = auds[i];
    const [gl, gr] = trackGains(t, base?.tracks[i] ?? t, plan, a.mono);
    if (!gl && !gr) return;
    const sections = eqsOf(t.eq).flatMap((eq) => eqSections(eq, fs));
    const chans = a.channels.map((c) => (sections.length ? applySections(Float32Array.from(c), sections) : c));
    const L = chans[0], R = chans[1] ?? chans[0];
    for (let k = 0; k < L.length; k++) { mix[0][k] += gl * L[k]; mix[1][k] += gr * R[k]; }
  });
  const og = dbToGain(plan.stereoOutGainDb);
  if (og !== 1) for (const c of mix) for (let k = 0; k < n; k++) c[k] *= og;
  return { channels: mix, sampleRate: fs };
}

function writeWav(file, channels, fs) {
  const n = channels[0].length;
  const inter = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { inter[2 * i] = channels[0][i]; inter[2 * i + 1] = channels[1][i]; }
  const res = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(fs), '-ac', '2', '-i', 'pipe:0', '-c:a', 'pcm_s24le', file],
    { input: Buffer.from(inter.buffer) });
  need(res.status === 0, `ffmpeg failed: ${res.stderr}`);
}

/* ---------------- analysis ---------------- */

function referenceAnalysis(file) {
  if (!file) return null;
  const st = statSync(file);
  const cache = join(stemsDir, 'reference.json');
  if (existsSync(cache)) {
    const c = JSON.parse(readFileSync(cache, 'utf8'));
    if (c.file === resolve(file) && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.analysis;
  }
  const { channels, sampleRate } = decode(file);
  const analysis = analyze(channels, sampleRate);
  writeFileSync(cache, JSON.stringify({ file: resolve(file), size: st.size, mtimeMs: st.mtimeMs, analysis }));
  return analysis;
}

const settings = () => ({ stage: 'mix', genre: flags.genre ?? 'rock', target: flags.target ?? 'streaming' });

/** Same convergence rules as analyze.mjs, so "converged" here means converged there. */
function judge(a, reference) {
  const ev = evaluate(a, settings(), { reference, file: { lossy: false } });
  const devs = ev.deviations;
  const maxAbs = Math.max(...devs.map(Math.abs));
  const rms = Math.sqrt(devs.reduce((s, d) => s + d * d, 0) / devs.length);
  const critical = ev.findings.filter((f) => f.severity === 'critical').map((f) => f.id);
  const warnings = ev.findings.filter((f) => f.severity === 'warning').map((f) => f.id);
  const score = rms + 0.5 * Math.max(0, maxAbs - ev.tolerance) + warnings.length + 3 * critical.length;
  const converged = maxAbs <= ev.tolerance && rms <= 1 && !critical.length && !warnings.length;
  return { ev, devs, maxAbs, rms, critical, warnings, score, converged };
}

function summary(a, j) {
  return [
    `${r1(a.integrated)} LUFS · ${r1(a.truePeakDb)} dBTP · PLR ${r1(a.plr)} · balance ${sgn(a.balanceDb ?? 0)} dB (L−R)`,
    `Bands: ${BANDS.map((b, i) => `${b.name} ${sgn(j.devs[i])}`).join(', ')} · RMS ${j.rms.toFixed(2)}`,
    `${j.converged ? 'CONVERGED' : 'not converged'} · score ${j.score.toFixed(2)} · issues: ${[...j.critical, ...j.warnings].join(', ') || 'none'}`,
  ].join('\n');
}

/** Left/right difference per window (8 bars by default), to catch sections that lean. */
function windowLean(channels, fs, seconds) {
  const n = Math.round(seconds * fs);
  const out = [];
  for (let s = 0; s + n / 4 < channels[0].length; s += n) {
    let l = 0, r = 0;
    const e = Math.min(channels[0].length, s + n);
    for (let i = s; i < e; i++) { l += channels[0][i] ** 2; r += channels[1][i] ** 2; }
    if (l + r > 1e-6 * (e - s)) out.push({ t: s / fs, db: 10 * Math.log10((l + 1e-20) / (r + 1e-20)) });
  }
  return out;
}

/* ---------------- fast linear model ---------------- */

const FFT = 16384;
/** Per-track third-octave power per channel and per-window channel power, measured once per file. */
function features(plan) {
  const cacheFile = join(stemsDir, 'features.json');
  const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
  const lengths = plan.tracks.map((t) => stemAudio(plan, t).channels[0].length);
  const n = Math.max(...lengths);
  let dirty = false;
  const out = plan.tracks.map((t) => {
    const file = resolve(plan.stemsDir, t.file);
    const st = statSync(file);
    const key = `v2|${file}|${st.size}|${st.mtimeMs}|${n}`;
    if (cache[key]) return cache[key];
    const a = stemAudio(plan, t);
    const pad = (c) => { const x = new Float32Array(n); x.set(c); return x; };
    const chans = a.channels.map(pad);
    // Per third octave: left power, right power and their cross term (mid − side), so pan and balance
    // changes predict mid, side and width as well as level.
    const third = chans.map((c) => measureSpectrum([c, c], a.sampleRate).thirds.map((th) => th.mid));
    const cross = chans.length === 2 ? measureSpectrum(chans, a.sampleRate).thirds.map((th) => th.mid - th.side) : third[0];
    let energy = 0;
    for (const c of chans) for (let i = 0; i < n; i += 4) energy += c[i] * c[i];
    const f = { mono: a.mono, third, cross, silent: energy < 1e-7 * n };
    cache[key] = f;
    dirty = true;
    return f;
  });
  if (dirty) writeFileSync(cacheFile, JSON.stringify(cache));
  const frames = n <= FFT ? 1 : Math.min(320, Math.floor((n - FFT) / (FFT / 4)) + 1);
  return { tracks: out, frames, fs: stemAudio(plan, plan.tracks[0]).sampleRate };
}

/** Power gain of an EQ chain per third octave, averaged across each third. */
function eqPowerPerThird(eqs, fs) {
  if (!eqs.length) return THIRD_OCTAVES.map(() => 1);
  return THIRD_OCTAVES.map((fc) => {
    const fr = [-2, -1, 0, 1, 2].map((k) => fc * 2 ** (k / 15));
    const db = fr.map(() => 0);
    for (const eq of eqs) eqResponse(eq, fr, fs).forEach((v, i) => { db[i] += v; });
    return db.reduce((s, v) => s + 10 ** (v / 10), 0) / fr.length;
  });
}

function predictBands(state, feat) {
  const total = THIRD_OCTAVES.map(() => 0);
  const mid = THIRD_OCTAVES.map(() => 0), side = THIRD_OCTAVES.map(() => 0);
  let pl = 0, pr = 0;
  state.forEach((s, i) => {
    const f = feat.tracks[i];
    if (!s.gl && !s.gr) return;
    const L = f.third[0], R = f.third[1] ?? f.third[0], C = f.cross;
    for (let k = 0; k < total.length; k++) {
      const a = s.gl * s.gl * L[k] * s.eqp[k], b = s.gr * s.gr * R[k] * s.eqp[k], c = 2 * s.gl * s.gr * C[k] * s.eqp[k];
      total[k] += (a + b) / 2;
      mid[k] += (a + b + c) / 4;
      side[k] += (a + b - c) / 4;
      pl += a; pr += b;
    }
  });
  const sum = (arr, pred) => arr.reduce((s, v, k) => (pred(THIRD_OCTAVES[k]) ? s + v : s), 0);
  const lowM = sum(mid, (fc) => fc <= 100), lowS = sum(side, (fc) => fc <= 100);
  const wM = sum(mid, (fc) => fc >= 160 && fc <= 16000), wS = sum(side, (fc) => fc >= 160 && fc <= 16000);
  const stereo = {
    lowCorrelation: lowM + lowS > 0 ? (lowM - lowS) / (lowM + lowS) : 1,
    widthDb: Math.max(-40, 10 * Math.log10((wS + 1e-30) / (wM + 1e-30))),
  };
  const levels = total.map((p, k) => (THIRD_OCTAVES[k] * 2 ** (1 / 6) > feat.fs / 2 ? -Infinity : 10 * Math.log10(p / feat.frames || 1e-30)));
  const top = Math.max(...levels.filter(Number.isFinite));
  const clamped = levels.map((l) => (Number.isFinite(l) ? Math.max(l, top - 90) : l));
  const bands = BANDS.map((b) => {
    const vals = clamped.filter((l, k) => THIRD_OCTAVES[k] >= b.lo && THIRD_OCTAVES[k] < b.hi && Number.isFinite(l));
    return 10 * Math.log10(vals.reduce((s, l) => s + 10 ** (l / 10), 0) / vals.length);
  });
  return { bands, balanceDb: 10 * Math.log10((pl + 1e-30) / (pr + 1e-30)), ...stereo };
}

/* ---------------- commands ---------------- */

function cmdInit() {
  need(arg && sessionDir, 'Usage: node tools/stem-mix.mjs init <stems dir> --session sessions/<slug>');
  const dir = resolve(arg);
  const files = readdirSync(dir).filter((f) => AUDIO.has(extname(f).toLowerCase())).sort();
  need(files.length, `No audio files in ${dir}`);
  mkdirSync(stemsDir, { recursive: true });
  const path = join(stemsDir, 'plan.json');
  need(!existsSync(path) || flags.force, `${path} exists; pass --force true to overwrite.`);
  const plan = {
    stemsDir: dir, stemMode: 'pre-fader', stereoOutGainDb: 0,
    tracks: files.map((f) => ({ name: basename(f, extname(f)), file: f, instrument: null, fader: 0, pan: 0, mute: false, eq: null })),
  };
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`Wrote ${path} with ${files.length} tracks. Fill in fader, pan, mute and instrument from the track map, then run match.`);
}

function cmdMatch() {
  need(flags.baseline, '--baseline <Logic mix bounce> is required.');
  const plan = loadPlan(flags.plan);
  const mix = render(plan, plan);
  const { channels: bch, sampleRate } = decode(flags.baseline);
  const n = Math.min(mix.channels[0].length, bch[0].length);
  const cut = (chs) => chs.map((c) => c.subarray(0, n));
  const a = analyze(cut(mix.channels), mix.sampleRate), b = analyze(cut(bch), sampleRate);
  // Null test: residual energy after removing the best single gain.
  let xy = 0, yy = 0, xx = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) { const x = mix.channels[c][i], y = bch[c][i]; xy += x * y; yy += y * y; xx += x * x; }
  const g = xy / (xx || 1);
  let res = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) res += (bch[c][i] - g * mix.channels[c][i]) ** 2;
  const nullDb = 10 * Math.log10(res / yy);
  const bandDiff = a.bands.map((v, i) => v - b.bands[i]);
  const med = [...bandDiff].sort((p, q) => p - q)[3];
  const shape = bandDiff.map((d) => d - med);
  const maxShape = Math.max(...shape.map(Math.abs));
  const lufs = a.integrated - b.integrated;
  const bal = (a.balanceDb ?? 0) - (b.balanceDb ?? 0);
  const ok = maxShape <= 0.5 && Math.abs(lufs) <= 0.5 && Math.abs(bal) <= 0.3;
  console.log(`Rebuilt vs Logic: level ${sgn(lufs)} LU · balance ${sgn(bal)} dB · null ${r1(nullDb)} dB · lengths ${r1(mix.channels[0].length / mix.sampleRate)} / ${r1(bch[0].length / sampleRate)} s`);
  console.log(`Band shape: ${BANDS.map((bd, i) => `${bd.name} ${sgn(shape[i])}`).join(', ')}`);
  console.log(ok ? 'MATCH: the rebuilt mix stands in for Logic (null below −20 dB is ideal; tonal shape is what the search uses).'
    : 'NO MATCH: check fader/pan/mute values, stemMode, aux returns (reverb sends are not in the files) and Stereo Out plug-ins.');
  writeFileSync(join(stemsDir, 'match.json'), JSON.stringify({ at: new Date().toISOString(), lufs, bal, nullDb, shape, ok }, null, 2));
  process.exitCode = ok ? 0 : 2;
}

const EQ_FAMILIES = [
  { re: /drum|kick|snare|tom|perc/i, presets: /drum|kick/i },
  { re: /bass/i, presets: /bass/i },
  { re: /guitar|gtr|eguitar/i, presets: /gtr|guitar/i },
];
function libraryFor(t) {
  const key = `${t.instrument ?? ''} ${t.name}`;
  const fam = EQ_FAMILIES.find((f) => f.re.test(key));
  if (!fam || !existsSync(PRESET_DIR)) return [];
  return readdirSync(PRESET_DIR).filter((f) => f.endsWith('.pst') && /^AE /.test(f) && fam.presets.test(f)).map((f) => f.slice(0, -4));
}

/**
 * EQ moves the search may make per instrument family, in the spirit of fix-playbook: low cuts and sub/bass cuts
 * on drums and bass, mid and presence moves on guitars, no low boosts on guitars. sign: -1 cuts only, 1 boosts only.
 */
const ALL_BUMPS = {
  p60: { type: 'peak', freq: 60, q: 1.2 }, p120: { type: 'peak', freq: 120, q: 1 }, p350: { type: 'peak', freq: 350, q: 1 },
  p1k: { type: 'peak', freq: 1000, q: 0.8 }, p3k: { type: 'peak', freq: 2800, q: 1 }, p6k: { type: 'peak', freq: 5600, q: 1 },
  hs: { type: 'highShelf', freq: 9000, q: 0.71 },
};
const FAMILY_MOVES = {
  drum: { bumps: { p60: -1, p120: -1, p350: -1, p3k: 0, p6k: 0, hs: 0 }, lowCuts: [30, 40, 50, 60] },
  bass: { bumps: { p60: -1, p120: 0, p350: 0, p1k: 1 }, lowCuts: [30, 40, 50, 60, 70] },
  guitar: { bumps: { p350: 0, p1k: 0, p3k: 0, p6k: 0, hs: 0 }, lowCuts: [80, 100, 120, 150] },
  other: { bumps: { p60: -1, p120: -1, p350: 0, p1k: 0, p3k: 0, p6k: 0, hs: 0 }, lowCuts: [40, 60, 80, 100] },
};
function familyOf(t) {
  const key = `${t.instrument ?? ''} ${t.name}`;
  if (/drum|kick|snare|tom|perc/i.test(key)) return 'drum';
  if (/bass/i.test(key)) return 'bass';
  if (/guitar|gtr/i.test(key)) return 'guitar';
  return 'other';
}

/** Sets the new EQ's low cut (24 dB/Oct). */
function lowCutEq(eq, freq) {
  const next = cloneEq(eq ?? flatEq());
  const b = next.bands.lowCut;
  if (b.on && b.freq === freq) return null;
  next.bands.lowCut = { on: true, freq, slope: 24, q: 0.71 };
  return next;
}

const MAX_CUT = 8, MAX_BOOST = 6; // dB per band on a new AE EQ, like the hand-made presets
const outOfRange = (g) => g < -MAX_CUT || g > MAX_BOOST;

/** Adds a bell or shelf move to an EQ, merging into a band at the same frequency. */
function bumpEq(eq, bump, gain) {
  const next = cloneEq(eq ?? flatEq());
  if (bump.type === 'highShelf') {
    const b = next.bands.highShelf;
    const g = (b.on ? b.gain : 0) + gain;
    next.bands.highShelf = { on: Math.abs(g) > 0.05, freq: b.on ? b.freq : bump.freq, gain: g, q: b.on ? b.q : bump.q };
    return outOfRange(g) ? null : next;
  }
  const same = PEAK_KEYS.find((k) => next.bands[k].on && Math.abs(Math.log2(next.bands[k].freq / bump.freq)) < 0.35);
  const key = same ?? PEAK_KEYS.find((k) => !next.bands[k].on);
  if (!key) return null;
  const old = next.bands[key];
  const g = (same ? old.gain : 0) + gain;
  if (outOfRange(g)) return null;
  next.bands[key] = { on: Math.abs(g) > 0.05, freq: same ? old.freq : bump.freq, gain: g, q: same ? old.q : bump.q };
  return next;
}

function cmdOptimize() {
  need(flags.ref, '--ref <reference> is required.');
  const plan = loadPlan(flags.plan);
  const reference = referenceAnalysis(flags.ref);
  const feat = features(plan);
  const maxFader = Number(flags['max-fader'] ?? 6);
  const tol = THRESHOLDS.toleranceReference ?? 2;
  const fs = feat.fs;

  // State per track: fader, pan, EQ list (existing AE EQs from the plan, then at most one new/changed AE EQ).
  const state = plan.tracks.map((t, i) => {
    const s = { fader: t.fader, pan: t.pan, eqs: eqsOf(t.eq), eqLabel: t.eq, newEq: null, active: !t.mute && !feat.tracks[i].silent };
    return s;
  });
  const refresh = (s, i) => {
    const t = plan.tracks[i];
    [s.gl, s.gr] = s.active ? trackGains({ ...t, fader: s.fader, pan: s.pan }, t, plan, feat.tracks[i].mono) : [0, 0];
    s.eqp = eqPowerPerThird(s.newEq ? [...s.eqs, s.newEq] : s.eqs, fs);
    return s;
  };
  state.forEach(refresh);

  const objective = (st) => {
    const p = predictBands(st, feat);
    const devs = bandDeviations(p.bands, reference.bands);
    const maxAbs = Math.max(...devs.map(Math.abs));
    const rms = Math.sqrt(devs.reduce((s, d) => s + d * d, 0) / devs.length);
    const out = devs.reduce((s, d) => s + Math.min(1, Math.max(0, Math.abs(d) - tol + 0.3)), 0); // smooth count of bands outside tolerance
    const lean = Math.max(0, Math.abs(p.balanceDb) - 0.7);
    // The analyzer's stereo warnings, from the predicted mid and side.
    const stereoIssues = (p.lowCorrelation < THRESHOLDS.lowCorr ? 1 : 0) + (p.widthDb > THRESHOLDS.widthWide ? 1 : 0) + (p.widthDb < THRESHOLDS.widthNarrow ? 1 : 0);
    // Cost of each move, so the search prefers few, small changes (each is clicks in Logic).
    let cost = 0;
    st.forEach((s, i) => {
      const t = plan.tracks[i];
      cost += 0.04 * Math.abs(s.fader - t.fader) + (s.fader !== t.fader ? 0.05 : 0) + (s.pan !== t.pan ? 0.05 : 0);
      if (s.newEq) {
        const on = BAND_KEYS.filter((k) => s.newEq.bands[k].on);
        cost += 0.15 + 0.04 * on.length + 0.015 * on.reduce((g, k) => g + Math.abs(s.newEq.bands[k].gain ?? 0), 0);
      }
    });
    return { score: rms + 3 * Math.max(0, rms - 0.9) + 0.5 * Math.max(0, maxAbs - tol) + out + 2 * lean + stereoIssues + cost, devs, rms, maxAbs, balanceDb: p.balanceDb };
  };

  // Rules an engineer applies before searching: low end in the centre.
  state.forEach((s, i) => {
    const t = plan.tracks[i];
    if (s.active && /bass|kick/i.test(`${t.instrument ?? ''} ${t.name}`) && feat.tracks[i].mono && s.pan !== 0) { s.pan = 0; refresh(s, i); }
  });

  // Left/right pairs (guitar-1-L / guitar-1-R) share EQ moves; faders move singly (balance) or together.
  const pairKey = (name) => name.replace(/[\s_-]*(L|R|Left|Right)$/i, '');
  const groups = new Map();
  plan.tracks.forEach((t, i) => { if (state[i].active) { const k = pairKey(t.name); groups.set(k, [...(groups.get(k) ?? []), i]); } });
  const eqTargets = [...groups.values()];
  const faderTargets = [...state.keys()].filter((i) => state[i].active).map((i) => [i]).concat(eqTargets.filter((g) => g.length > 1));

  let best = objective(state);
  const start = best;
  const FADER_STEPS = [-6, -4, -3, -2, -1, -0.5, 0.5, 1, 2, 3, 4];
  const GAIN_STEPS = [-6, -4, -2, -1, 1, 2, 4];
  const keys = ['fader', 'pan', 'newEq', 'gl', 'gr', 'eqp'];
  for (let iter = 0; iter < 80; iter++) {
    let bestMove = null;
    const tryMove = (idx, apply, label) => {
      const saved = idx.map((i) => Object.fromEntries(keys.map((k) => [k, state[i][k]])));
      let ok = true;
      for (const i of idx) if (apply(state[i], i) === false) ok = false;
      if (ok) {
        idx.forEach((i) => refresh(state[i], i));
        const o = objective(state);
        if (process.env.SM_DEBUG && iter === Number(process.env.SM_DEBUG)) console.error(`${plan.tracks[idx[0]].name} ${label}: ${o.score.toFixed(2)} [${o.devs.map(sgn).join(" ")}]`);
        if (o.score < (bestMove?.o.score ?? best.score) - 0.01) {
          bestMove = { o, label, next: idx.map((i) => [i, { fader: state[i].fader, pan: state[i].pan, newEq: state[i].newEq }]) };
        }
      }
      idx.forEach((i, n) => Object.assign(state[i], saved[n]));
    };
    for (const idx of faderTargets) {
      for (const d of FADER_STEPS) {
        tryMove(idx, (x, i) => {
          const f = Math.round((x.fader + d) * 10) / 10;
          if (Math.abs(f - plan.tracks[i].fader) > maxFader || f > 6) return false; // Logic's faders stop at +6 dB
          x.fader = f;
        }, `fader ${sgn(d)}`);
      }
    }
    // An EQ move is also tried with a fader change on the same tracks: a low cut plus more fader often fixes
    // what neither does alone.
    const COMP = [0, -3, -2, -1, 1, 2, 3];
    const tryEq = (idx, change, label) => {
      for (const d of COMP) {
        tryMove(idx, (x, i) => {
          const e = change(x);
          if (!e) return false;
          const f = Math.round((x.fader + d) * 10) / 10;
          if (Math.abs(f - plan.tracks[i].fader) > maxFader || f > 6) return false; // Logic's faders stop at +6 dB
          x.newEq = e; x.fader = f;
        }, d ? `${label} + fader ${sgn(d)}` : label);
      }
    };
    if (!flags['no-eq']) {
      for (const idx of eqTargets) {
        const first = state[idx[0]];
        if (!first.newEq) {
          for (const name of libraryFor(plan.tracks[idx[0]])) tryEq(idx, () => presetEq(name), `preset ${name}`);
        }
        const moves = FAMILY_MOVES[familyOf(plan.tracks[idx[0]])];
        for (const [id, sign] of Object.entries(moves.bumps)) {
          const bump = ALL_BUMPS[id];
          if (bump.freq * 1.5 > fs / 2) continue;
          for (const g of GAIN_STEPS) {
            if (sign && Math.sign(g) !== sign) continue;
            tryEq(idx, (x) => bumpEq(x.newEq, bump, g), `${bump.type} ${bump.freq} ${sgn(g)}`);
          }
        }
        for (const f of moves.lowCuts) tryEq(idx, (x) => lowCutEq(x.newEq, f), `low cut ${f}`);
      }
    }
    if (!bestMove) break;
    for (const [i, v] of bestMove.next) { Object.assign(state[i], v); refresh(state[i], i); }
    best = bestMove.o;
  }

  // Build the proposed plan.
  const prefix = flags.prefix ?? 'AE';
  const next = JSON.parse(JSON.stringify(plan));
  const apply = [];
  state.forEach((s, i) => {
    const t = plan.tracks[i], n = next.tracks[i];
    n.fader = s.fader; n.pan = s.pan;
    if (s.pan !== t.pan) apply.push(`${t.name}: pan ${t.pan} → ${s.pan}`);
    if (s.fader !== t.fader) apply.push(`${t.name}: fader ${t.fader.toFixed(1)} → ${s.fader.toFixed(1)}`);
    if (s.newEq) {
      const existing = Array.isArray(t.eq) ? t.eq : t.eq ? [t.eq] : [];
      const lib = libraryFor(t).find((p) => presetEq(p) === s.newEq);
      const entry = lib ? { preset: lib } : { name: `${prefix} ${pairKey(t.name)}`, bands: eqSpecs(s.newEq) };
      n.eq = [...existing, entry];
      apply.push(`${t.name}: new Channel EQ "${entry.preset ?? entry.name}" (${eqLines(s.newEq).join(' · ')})`);
    }
  });

  // Verify with a real render and the analyzer, then set Stereo Out headroom if needed.
  const verify = () => {
    const mix = render(next, plan);
    return { mix, a: analyze(mix.channels, mix.sampleRate) };
  };
  let { mix, a } = verify();
  if (a.truePeakDb > THRESHOLDS.mixHeadroom - 1) {
    const trim = Math.floor((THRESHOLDS.mixHeadroom - 2 - a.truePeakDb) * 2) / 2 + plan.stereoOutGainDb;
    next.stereoOutGainDb = trim;
    apply.push(`Stereo Out: Gain plug-in ${sgn(plan.stereoOutGainDb)} → ${sgn(trim)} dB (headroom: rebuilt mix peaks at ${r1(a.truePeakDb)} dBTP)`);
    ({ mix, a } = verify());
  }
  const j = judge(a, reference);
  const leans = windowLean(mix.channels, mix.sampleRate, Number(flags.window ?? 8 * 4 * 60 / Number(flags.bpm ?? 85)));
  const worst = leans.reduce((m, w) => (Math.abs(w.db) > Math.abs(m.db) ? w : m), { db: 0, t: 0 });

  writeFileSync(join(stemsDir, 'plan-next.json'), `${JSON.stringify(next, null, 2)}\n`);
  const lines = [
    `Predicted score ${start.score.toFixed(2)} → ${best.score.toFixed(2)} (model) · ${apply.length} moves · model bands ${best.devs.map(sgn).join(' ')}`,
    ...apply.map((l) => `  ${l}`),
    `Rendered: ${summary(a, j).split('\n').join('\n          ')}`,
    `Worst window lean ${sgn(worst.db)} dB (L−R) at ${Math.round(worst.t)} s`,
  ];
  writeFileSync(join(stemsDir, 'apply.txt'), `${lines.join('\n')}\n`);
  if (flags.out) writeWav(resolve(flags.out), mix.channels, mix.sampleRate);
  console.log(lines.join('\n'));
  process.exitCode = j.converged ? 0 : 2;
}

function cmdRender() {
  const plan = loadPlan(flags.plan);
  const base = flags.plan ? loadPlan() : plan;
  const mix = render(plan, base);
  const a = analyze(mix.channels, mix.sampleRate);
  if (flags.out) writeWav(resolve(flags.out), mix.channels, mix.sampleRate);
  if (flags.ref) {
    const j = judge(a, referenceAnalysis(flags.ref));
    console.log(summary(a, j));
    process.exitCode = j.converged ? 0 : 2;
  } else {
    console.log(`${r1(a.integrated)} LUFS · ${r1(a.truePeakDb)} dBTP · balance ${sgn(a.balanceDb ?? 0)} dB`);
  }
}

function cmdPresets() {
  const plan = loadPlan(flags.plan ?? 'plan-next.json');
  const done = new Set(); // L/R pairs share one preset
  for (const t of plan.tracks) {
    const list = Array.isArray(t.eq) ? t.eq : t.eq ? [t.eq] : [];
    for (const e of list) {
      if (!e.bands || done.has(e.name)) continue;
      done.add(e.name);
      const eq = normalizeEq(buildEq(e.bands.map(parseBand), { maxGain: 24 }).eq);
      const path = join(PRESET_DIR, presetFileName(e.name));
      if (!flags['dry-run']) { mkdirSync(PRESET_DIR, { recursive: true }); writeFileSync(path, encodeChannelEq(eq)); }
      console.log(`${flags['dry-run'] ? 'Would write' : 'Wrote'} "${e.name}" for ${t.name}: ${eqLines(eq).join(' · ')}`);
    }
  }
}

const COMMANDS = { init: cmdInit, match: cmdMatch, optimize: cmdOptimize, render: cmdRender, presets: cmdPresets };
need(COMMANDS[command], 'Usage: node tools/stem-mix.mjs init|match|optimize|render|presets … (see the header of this file)');
need(command === 'init' || sessionDir, '--session sessions/<slug> is required.');
COMMANDS[command]();
