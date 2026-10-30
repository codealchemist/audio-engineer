#!/usr/bin/env node
/**
 * Headless Mixdown Report: analyzes a bounce with the web app's own core, compares it with a reference
 * track (or a genre curve), and decides whether the mix has converged.
 *
 *   node tools/analyze.mjs <mix.wav> [--ref ref.wav] [--stage mix|master] [--genre pop] [--target streaming]
 *                         [--session sessions/<song>] [--changes "what changed since the last bounce"]
 *                         [--current-correction "<path to Mixdown correction.pst>"] [--max-dev 2] [--max-rms 1] [--json]
 *
 * With --session, each run is saved as iter-NN/{analysis.json,report.txt}, compared with the previous
 * iteration, and appended to log.md. Exit code: 0 converged, 2 not converged, 1 error.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { core, decode, parseFlags } from './lib.mjs';

const { analyze } = await core('analyze.js');
const { evaluate } = await core('evaluate.js');
const { reportText } = await core('report.js');
const { BANDS, THRESHOLDS } = await core('profiles.js');
const { suggestMasterEq } = await core('eq/mastering.js');
const { decodeChannelEq } = await core('eq/pst.js');
const { eqLines } = await core('eq/channel-eq.js');

const flags = parseFlags(process.argv.slice(2), { booleans: ['json'] });
const mixFile = flags._[0];
if (!mixFile) {
  console.error('Usage: node tools/analyze.mjs <mix.wav> [--ref ref.wav] [--stage mix|master] [--genre pop] [--target streaming] [--session dir] [--changes text]');
  process.exit(1);
}
const settings = { stage: flags.stage ?? 'mix', genre: flags.genre ?? 'pop', target: flags.target ?? 'streaming' };
const sessionDir = flags.session ? resolve(flags.session) : null;
if (sessionDir) mkdirSync(sessionDir, { recursive: true });

const r1 = (x) => Math.round(x * 10) / 10;
const f1 = (x) => r1(x).toFixed(1);
const sgn = (x) => `${x > 0 ? '+' : ''}${r1(x).toFixed(1)}`;
const sha1 = (file) => createHash('sha1').update(readFileSync(file)).digest('hex');

function measure(file) {
  const { channels, sampleRate, meta } = decode(file);
  return { analysis: analyze(channels, sampleRate), meta };
}

/** The reference rarely changes, so its analysis is cached next to the session (keyed by size and mtime). */
function referenceAnalysis(file) {
  if (!file) return null;
  const stat = statSync(file);
  const key = { file: resolve(file), size: stat.size, mtimeMs: stat.mtimeMs };
  const cache = sessionDir ? join(sessionDir, 'reference.json') : null;
  if (cache && existsSync(cache)) {
    const cached = JSON.parse(readFileSync(cache, 'utf8'));
    if (cached.file === key.file && cached.size === key.size && cached.mtimeMs === key.mtimeMs) return cached.analysis;
  }
  const { analysis, meta } = measure(file);
  if (meta.lossy) console.warn(`Note: the reference is lossy (${meta.format}); its Air band may read low. Prefer WAV/AIFF/FLAC.`);
  if (cache) writeFileSync(cache, JSON.stringify({ ...key, analysis }));
  return analysis;
}

function convergence(a, ev) {
  const maxDevGoal = Number(flags['max-dev'] ?? ev.tolerance);
  const maxRmsGoal = Number(flags['max-rms'] ?? 1);
  const devs = ev.deviations;
  const maxAbs = Math.max(...devs.map(Math.abs));
  const rms = Math.sqrt(devs.reduce((s, d) => s + d * d, 0) / devs.length);
  const critical = ev.findings.filter((f) => f.severity === 'critical').map((f) => f.id);
  const warnings = ev.findings.filter((f) => f.severity === 'warning').map((f) => f.id);
  const notes = ev.findings.filter((f) => f.severity === 'note').map((f) => f.id);
  const checks = {
    curveMax: { ok: maxAbs <= maxDevGoal, value: r1(maxAbs), goal: `≤ ${maxDevGoal} dB per band` },
    curveRms: { ok: rms <= maxRmsGoal, value: Math.round(rms * 100) / 100, goal: `≤ ${maxRmsGoal} dB RMS` },
    noCritical: { ok: !critical.length, value: critical },
    noWarnings: { ok: !warnings.length, value: warnings },
  };
  if (ev.stage === 'master') {
    checks.loudness = { ok: Math.abs(a.integrated - ev.target.lufs) <= 0.5, value: r1(a.integrated), goal: `${ev.target.lufs} ±0.5 LUFS` };
    checks.truePeak = { ok: a.truePeakDb <= ev.target.truePeak, value: r1(a.truePeakDb), goal: `≤ ${ev.target.truePeak} dBTP` };
  }
  // One number to track progress between iterations: lower is better.
  const score = Math.round((rms + 0.5 * Math.max(0, maxAbs - maxDevGoal) + warnings.length + 3 * critical.length) * 100) / 100;
  return { converged: Object.values(checks).every((c) => c.ok), score, maxAbs: r1(maxAbs), rms: checks.curveRms.value, checks, notes };
}

function previousIteration() {
  if (!sessionDir || !existsSync(sessionDir)) return { prev: null, next: 1 };
  const iters = readdirSync(sessionDir).filter((d) => /^iter-\d+$/.test(d)).sort();
  if (!iters.length) return { prev: null, next: 1 };
  const last = iters.at(-1);
  const file = join(sessionDir, last, 'analysis.json');
  return { prev: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null, next: Number(last.slice(5)) + 1 };
}

function deltaText(prev, cur) {
  const lines = [`CHANGE SINCE ITERATION ${prev.iteration}`];
  if (prev.sha1 === cur.sha1) lines.push('  WARNING: the bounce is byte-identical to the previous iteration. The export may not have overwritten the file.');
  const pa = prev.analysis, a = cur.analysis;
  lines.push(`  Integrated ${f1(pa.integrated)} → ${f1(a.integrated)} LUFS · True peak ${f1(pa.truePeakDb)} → ${f1(a.truePeakDb)} dBTP · PLR ${f1(pa.plr)} → ${f1(a.plr)} dB`);
  lines.push(`  Tonal deviation: ${BANDS.map((b, i) => `${b.name} ${sgn(prev.evaluation.deviations[i])}→${sgn(cur.evaluation.deviations[i])}`).join(', ')}`);
  const before = new Set(prev.evaluation.findings.map((f) => f.id));
  const after = new Set(cur.evaluation.findings.map((f) => f.id));
  const resolved = [...before].filter((id) => !after.has(id));
  const added = [...after].filter((id) => !before.has(id));
  if (resolved.length) lines.push(`  Resolved: ${resolved.join(', ')}`);
  if (added.length) lines.push(`  New: ${added.join(', ')}`);
  const d = cur.convergence.score - prev.convergence.score;
  cur.trend = d < -0.1 ? 'improving' : d > 0.1 ? 'regressed' : 'stalled';
  lines.push(`  Score ${prev.convergence.score} → ${cur.convergence.score} (${cur.trend})`);
  return lines.join('\n');
}

function convergenceText(c) {
  const lines = [`CONVERGENCE: ${c.converged ? 'CONVERGED' : 'not yet'} (score ${c.score}, lower is better)`];
  for (const [name, check] of Object.entries(c.checks)) {
    const value = Array.isArray(check.value) ? (check.value.join(', ') || 'none') : check.value;
    lines.push(`  [${check.ok ? 'x' : ' '}] ${name}: ${value}${check.goal ? ` (goal ${check.goal})` : ''}`);
  }
  if (c.notes.length) lines.push(`  Notes to review (don't block convergence): ${c.notes.join(', ')}`);
  return lines.join('\n');
}

const reference = referenceAnalysis(flags.ref);
const { analysis, meta } = measure(mixFile);
const ev = evaluate(analysis, settings, { reference, file: meta });

let current = null;
if (flags['current-correction']) current = decodeChannelEq(readFileSync(flags['current-correction'])).eq;
const correction = suggestMasterEq(ev, { analysis, current });

const { prev, next } = previousIteration();
const result = {
  version: 1,
  iteration: sessionDir ? next : null,
  createdAt: new Date().toISOString(),
  file: resolve(mixFile),
  sha1: sha1(mixFile),
  meta,
  settings: ev.settings,
  referenceFile: flags.ref ? resolve(flags.ref) : null,
  changes: flags.changes ?? null,
  analysis,
  reference,
  evaluation: {
    stage: ev.stage, basis: ev.basis, tolerance: ev.tolerance, deviations: ev.deviations,
    findings: ev.findings, ok: ev.ok, chain: ev.chain, masterMoves: ev.masterMoves, target: ev.target,
  },
  correctionEq: { mode: correction.mode, lines: eqLines(correction.eq), eq: correction.eq, notes: correction.notes },
  convergence: convergence(analysis, ev),
};

const report = reportText(analysis, ev, { name: basename(mixFile), referenceName: flags.ref ? basename(flags.ref) : undefined });
const sections = [report, '', `SUGGESTED "Mixdown correction" EQ (${correction.mode}): ${result.correctionEq.lines.join(' · ')}`];
if (correction.notes.length) sections.push(...correction.notes.map((n) => `  - ${n}`));
sections.push('', convergenceText(result.convergence));
if (prev) sections.push('', deltaText(prev, result));
const text = sections.join('\n');

if (sessionDir) {
  const dir = join(sessionDir, `iter-${String(next).padStart(2, '0')}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'analysis.json'), JSON.stringify(result, null, 2));
  writeFileSync(join(dir, 'report.txt'), `${text}\n`);
  const log = join(sessionDir, 'log.md');
  if (!existsSync(log)) {
    appendFileSync(log, `# Iteration log\n\nStage ${settings.stage} · genre ${settings.genre} · target ${settings.target} · basis: ${ev.basis}\n\n`
      + `| Iter | Time | Changes before this bounce | LUFS | dBTP | PLR | ${BANDS.map((b) => b.name).join(' | ')} | RMS dev | Issues | Score | Status |\n`
      + `|${' --- |'.repeat(10 + BANDS.length)}\n`);
  }
  const c = result.convergence;
  const issues = [...c.checks.noCritical.value, ...c.checks.noWarnings.value].join(', ') || '—';
  const status = c.converged ? 'CONVERGED' : (result.trend ?? 'baseline');
  const local = new Date(result.createdAt);
  const stamp = `${local.toLocaleDateString('sv-SE')} ${local.toTimeString().slice(0, 5)}`;
  appendFileSync(log, `| ${next} | ${stamp} | ${(flags.changes ?? '—').replace(/\|/g, '/')} | ${f1(analysis.integrated)} | ${f1(analysis.truePeakDb)} | ${f1(analysis.plr)} | `
    + `${ev.deviations.map(sgn).join(' | ')} | ${c.rms} | ${issues} | ${c.score} | ${status} |\n`);
  console.error(`Saved ${dir}`);
}

console.log(flags.json ? JSON.stringify(result, null, 2) : text);
process.exitCode = result.convergence.converged ? 0 : 2;
