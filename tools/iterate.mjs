#!/usr/bin/env node
/**
 * One command per bounce: waits for Logic to finish writing it, analyzes it into the session (iter-NN + log.md,
 * exactly like analyze.mjs), checks left/right per section, and prints about five lines instead of the full report.
 * The full report stays in <session>/iter-NN/report.txt for when the short version isn't enough.
 *
 *   node tools/iterate.mjs <bounce.wav> --since <epoch ms> --session sessions/<slug> --ref <reference>
 *                          [--stage mix|master] [--genre rock] [--target streaming] [--changes "…"] [--bpm 85]
 *                          [--current-correction "<.pst>"] [--timeout 300]
 * Exit code: 0 converged, 2 not converged, 1 error or timeout.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, parseFlags } from './lib.mjs';

const flags = parseFlags(process.argv.slice(2));
const file = flags._[0];
if (!file || !flags.session || !flags.ref) {
  console.error('Usage: node tools/iterate.mjs <bounce.wav> --since <ms> --session sessions/<slug> --ref <reference> [--stage mix|master] [--changes …]');
  process.exit(1);
}
const here = dirname(fileURLToPath(import.meta.url));

async function waitForBounce() {
  if (!flags.since) return;
  const since = /^\d+$/.test(flags.since) ? Number(flags.since) : Date.parse(flags.since);
  const deadline = Date.now() + Number(flags.timeout ?? 300) * 1000;
  let last = null, stableSince = 0;
  for (;;) {
    if (existsSync(file)) {
      const { size, mtimeMs } = statSync(file);
      const sig = `${size}:${mtimeMs}`;
      if (mtimeMs >= since && size > 44) {
        if (sig !== last) { last = sig; stableSince = Date.now(); }
        else if (Date.now() - stableSince >= 3000) return;
      }
    }
    if (Date.now() > deadline) { console.log(`Timed out: ${file} was not written after ${new Date(since).toLocaleTimeString()}.`); process.exit(1); }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

await waitForBounce();
const args = [join(here, 'analyze.mjs'), file, '--ref', flags.ref, '--session', flags.session, '--json',
  '--stage', flags.stage ?? 'mix', '--genre', flags.genre ?? 'rock', '--target', flags.target ?? 'streaming'];
if (flags.changes) args.push('--changes', flags.changes);
if (flags['current-correction']) args.push('--current-correction', flags['current-correction']);
const res = spawnSync(process.execPath, args, { maxBuffer: 256 * 1024 * 1024 });
if (res.status === 1 || !res.stdout.length) { console.error(res.stderr.toString()); process.exit(1); }
const r = JSON.parse(res.stdout.toString());

const r1 = (x) => Math.round(x * 10) / 10;
const sgn = (x) => `${x > 0 ? '+' : ''}${r1(x).toFixed(1)}`;
const NAMES = ['Sub', 'Bass', 'LowMid', 'Mid', 'UpMid', 'Pres', 'Air'];
const a = r.analysis, c = r.convergence;
const issues = [...c.checks.noCritical.value, ...c.checks.noWarnings.value];

// Left/right per window (8 bars), the check lr.mjs used to do.
const { channels, sampleRate } = decode(file);
const win = Math.round((Number(flags.window ?? (8 * 4 * 60) / Number(flags.bpm ?? 85))) * sampleRate);
let worst = { db: 0, bar: 1 };
if (channels.length === 2) {
  for (let s = 0, k = 0; s + win / 4 < channels[0].length; s += win, k++) {
    let l = 0, rr = 0;
    const e = Math.min(channels[0].length, s + win);
    for (let i = s; i < e; i++) { l += channels[0][i] ** 2; rr += channels[1][i] ** 2; }
    if (l + rr < 1e-6 * (e - s)) continue;
    const db = 10 * Math.log10((l + 1e-20) / (rr + 1e-20));
    if (Math.abs(db) > Math.abs(worst.db)) worst = { db, bar: k * 8 + 1 };
  }
}

const lines = [
  `iter ${r.iteration} · ${r1(a.integrated)} LUFS · ${r1(a.truePeakDb)} dBTP · PLR ${r1(a.plr)} · balance ${sgn(a.balanceDb ?? 0)} (L−R) · worst 8 bars ${sgn(worst.db)} at bar ${worst.bar}`,
  `${r.evaluation.deviations.map((d, i) => `${NAMES[i]} ${sgn(d)}`).join(' ')} · RMS ${c.rms}`,
  `${c.converged ? 'CONVERGED' : 'not converged'} · score ${c.score}${r.trend ? ` (${r.trend})` : ''} · issues: ${issues.join(', ') || 'none'}${c.notes.length ? ` · notes: ${c.notes.join(', ')}` : ''}`,
];
if ((flags.stage ?? 'mix') === 'master') lines.push(`Correction EQ (${r.correctionEq.mode}): ${r.correctionEq.lines.join(' · ')}`);
const prevFile = join(flags.session, `iter-${String(r.iteration - 1).padStart(2, '0')}`, 'analysis.json');
if (r.iteration > 1 && existsSync(prevFile) && JSON.parse(readFileSync(prevFile, 'utf8')).sha1 === r.sha1) {
  lines.push('WARNING: byte-identical to the previous bounce; Logic may not have overwritten the file.');
}
console.log(lines.join('\n'));
process.exitCode = c.converged ? 0 : 2;
