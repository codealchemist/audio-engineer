#!/usr/bin/env node
/**
 * Plans the Stereo Out master offline from the converged mix bounce, so Logic needs one master bounce instead of
 * several: picks the "Mixdown correction" Channel EQ (closed loop, re-measured after each fit) and the Adaptive
 * Limiter Gain that lands on the loudness target, by simulating EQ → limiter on the mix.
 *
 *   node tools/master-plan.mjs <mix.wav> --ref <reference> [--genre rock] [--target streaming]
 *       [--name "Mixdown correction - PR10-04"] [--write] [--ceiling -1.2] [--pre-gain dB] [--out master-sim.wav]
 *   Check a chain you already have (no search):
 *   node tools/master-plan.mjs <mix.wav> --ref <reference> --eq "Mixdown correction - PR10-03" --gain 5.6
 *
 * --pre-gain is a Gain plug-in before the correction EQ (e.g. −4 on PR10-02). --write saves the EQ preset into
 * Logic's Audio Engineer folder. The simulated limiter is Mixdown Report's true-peak limiter, not Logic's Adaptive
 * Limiter; LIMITER_BIAS (measured on PR10-03) corrects the difference in loudness. Exit code 0 when the simulated
 * master converges.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PRESET_DIR, core, decode, parseFlags } from './lib.mjs';

const { analyze } = await core('analyze.js');
const { evaluate } = await core('evaluate.js');
const { BANDS } = await core('profiles.js');
const { suggestMasterEq } = await core('eq/mastering.js');
const { eqSections } = await core('eq/response.js');
const { applySections } = await core('dsp/biquad.js');
const { limit } = await core('master/limiter.js');
const { measureLoudness } = await core('loudness.js');
const { eqLines, normalizeEq } = await core('eq/channel-eq.js');
const { encodeChannelEq, decodeChannelEq, presetFileName } = await core('eq/pst.js');

/**
 * Logic's Adaptive Limiter reaches less loudness than this simulation at the same Gain: measured on the
 * PR10-01/02/03 masters (Gain 5 / 7.7 / 5.6 gave −13.9 / −13.9 / −14.1 LUFS in Logic, −12.6 / −12.7 / −12.9 here),
 * 1.2–1.3 dB. The plan asks Logic for this much more Gain than the simulation used.
 */
const LIMITER_BIAS = 1.2;
const MAX_LIMITER_GAIN = 12; // Adaptive Limiter's Gain range; the rest goes on the EQ's output gain

const flags = parseFlags(process.argv.slice(2), { booleans: ['write'] });
const mixFile = flags._[0];
if (!mixFile || !flags.ref) {
  console.error('Usage: node tools/master-plan.mjs <mix.wav> --ref <reference> [--name …] [--write] (see the header)');
  process.exit(1);
}
const r1 = (x) => Math.round(x * 10) / 10;
const sgn = (x) => `${x > 0 ? '+' : ''}${r1(x).toFixed(1)}`;
const settings = { stage: 'master', genre: flags.genre ?? 'rock', target: flags.target ?? 'streaming' };
const ceiling = Number(flags.ceiling ?? -1.2);
const bias = Number(flags.bias ?? LIMITER_BIAS);

const ref = decode(flags.ref);
const reference = analyze(ref.channels, ref.sampleRate);
const { channels: raw, sampleRate: fs } = decode(mixFile);
const preGain = 10 ** (Number(flags['pre-gain'] ?? 0) / 20);
const mix = raw.length === 1 ? [raw[0], raw[0]] : raw;
if (preGain !== 1) for (const c of mix) for (let i = 0; i < c.length; i++) c[i] *= preGain;

const withEq = (eq) => {
  const sections = eqSections(eq, fs);
  return mix.map((c) => applySections(Float32Array.from(c), sections));
};
const limited = (chs, gainDb) => {
  const out = chs.map((c) => Float32Array.from(c));
  limit(out, fs, { ceilingDb: ceiling, inputGainDb: gainDb });
  return out;
};
const judge = (a) => {
  const ev = evaluate(a, settings, { reference, file: { lossy: false } });
  const devs = ev.deviations;
  const maxAbs = Math.max(...devs.map(Math.abs));
  const rms = Math.sqrt(devs.reduce((s, d) => s + d * d, 0) / devs.length);
  const issues = ev.findings.filter((f) => f.severity !== 'note').map((f) => f.id);
  const ok = maxAbs <= ev.tolerance && rms <= 1 && !issues.length && Math.abs(a.integrated - ev.target.lufs) <= 0.5 && a.truePeakDb <= ev.target.truePeak;
  return { ev, devs, rms, issues, ok };
};

/** Limiter Gain for the target loudness, by secant search on the simulation. */
function findGain(chs, target) {
  let g = target - measureLoudness(chs, fs).integrated;
  for (let pass = 0; pass < 6; pass++) {
    const lufs = measureLoudness(limited(chs, g), fs).integrated;
    const err = target - lufs;
    if (Math.abs(err) < 0.05) break;
    g += err;
  }
  return g;
}

let eq, gain;
const target = evaluate(analyze(mix, fs), settings, { reference, file: {} }).target.lufs;
if (flags.eq) {
  const path = join(PRESET_DIR, presetFileName(flags.eq));
  if (!existsSync(path)) throw new Error(`Preset not found: ${path}`);
  eq = decodeChannelEq(readFileSync(path)).eq;
} else {
  // Closed loop: fit, apply, re-measure, update the same EQ (like the in-Logic master loop, without bounces).
  let current = null;
  for (let round = 0; round < 4; round++) {
    const chs = current ? withEq(current) : mix;
    const a = analyze(chs, fs);
    const ev = evaluate(a, settings, { reference, file: { lossy: false } });
    if (current && ev.deviations.every((d) => Math.abs(d) <= 1)) break;
    const s = suggestMasterEq(ev, { analysis: a, current });
    if (s.unchanged) break;
    current = normalizeEq(s.eq);
  }
  eq = current ?? normalizeEq(suggestMasterEq(evaluate(analyze(mix, fs), settings, { reference, file: {} }), {}).eq);
}

const eqd = withEq(eq);
if (flags.gain !== undefined) gain = Number(flags.gain) - bias;
else gain = findGain(eqd, target);
let logicGain = Math.round((gain + bias) * 10) / 10;
let extraOutput = 0;
if (logicGain > MAX_LIMITER_GAIN) {
  extraOutput = r1(logicGain - MAX_LIMITER_GAIN);
  logicGain = MAX_LIMITER_GAIN;
  eq.outputGain = r1(eq.outputGain + extraOutput);
}

const master = limited(extraOutput ? withEq(eq) : eqd, logicGain - bias);
const a = analyze(master, fs);
const j = judge(a);

const name = flags.name ?? 'Mixdown correction';
const lines = [
  `Correction EQ "${name}": ${eqLines(eq).join(' · ')}`,
  `Adaptive Limiter: Gain ${logicGain.toFixed(1)} · Out Ceiling ${ceiling} · True Peak on${extraOutput ? ` (Gain is maxed; +${extraOutput} dB on the EQ's output gain)` : ''}`,
  `Simulated master: ${r1(a.integrated)} LUFS · ${r1(a.truePeakDb)} dBTP · PLR ${r1(a.plr)} · ${BANDS.map((b, i) => `${b.name} ${sgn(j.devs[i])}`).join(', ')} · RMS ${j.rms.toFixed(2)}`,
  `${j.ok ? 'CONVERGED' : 'not converged'} (simulated) · issues: ${j.issues.join(', ') || 'none'}`,
];
console.log(lines.join('\n'));

if (flags.write && !flags.eq) {
  mkdirSync(PRESET_DIR, { recursive: true });
  const path = join(PRESET_DIR, presetFileName(name));
  writeFileSync(path, encodeChannelEq(eq));
  console.log(`Wrote ${path}`);
}
if (flags.out) {
  const n = master[0].length, inter = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { inter[2 * i] = master[0][i]; inter[2 * i + 1] = master[1][i]; }
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(fs), '-ac', '2', '-i', 'pipe:0', '-c:a', 'pcm_s24le', resolve(flags.out)], { input: Buffer.from(inter.buffer) });
}
process.exitCode = j.ok ? 0 : 2;
