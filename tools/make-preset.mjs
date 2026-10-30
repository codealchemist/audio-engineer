#!/usr/bin/env node
/**
 * Writes Logic Pro Channel EQ presets (.pst) with Mixdown Report's encoder, straight into Logic's preset
 * folder (Channel EQ › Setting menu › Audio Engineer), so fixes are loaded instead of dialled in by hand.
 *
 * Explicit bands (type:freq:gain[:q], cuts are type:freq:slope):
 *   node tools/make-preset.mjs --name "AE Lead vocal" --band lowCut:90:18 --band peak:300:-2.5:1.2 --band highShelf:10000:1.5
 * An instrument's starting point plus fixes for the analyzed mix (ids: --list-instruments):
 *   node tools/make-preset.mjs --name "AE Kick" --instrument kick --analysis sessions/song/iter-03/analysis.json
 * The Stereo Out correction EQ, updating the one already in the bounce:
 *   node tools/make-preset.mjs --correction --analysis sessions/song/iter-03/analysis.json [--current "<old .pst>"]
 *
 * Options: --output-gain dB, --dir folder (default: AE_PRESET_DIR or Logic's Channel EQ/Audio Engineer), --dry-run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRESET_DIR, core, parseFlags } from './lib.mjs';

const { buildEq, eqLines, normalizeEq } = await core('eq/channel-eq.js');
const { encodeChannelEq, decodeChannelEq, presetFileName } = await core('eq/pst.js');
const { suggestTrackEq } = await core('eq/track-eq.js');
const { suggestMasterEq } = await core('eq/mastering.js');
const { CORRECTION_NAME } = await core('eq/correction.js');
const { INSTRUMENTS } = await core('eq/instruments.js');
const { evaluate } = await core('evaluate.js');

const flags = parseFlags(process.argv.slice(2), { multi: ['band'], booleans: ['correction', 'dry-run', 'list-instruments'] });

if (flags['list-instruments']) {
  for (const i of INSTRUMENTS) console.log(`${i.id.padEnd(15)} ${i.name} (${i.group})`);
  process.exit(0);
}

const TYPES = new Set(['lowCut', 'highCut', 'lowShelf', 'highShelf', 'peak']);
function parseBand(spec) {
  const [type, freq, third, q] = spec.split(':');
  if (!TYPES.has(type)) throw new Error(`Unknown band type "${type}" in ${spec}. Use ${[...TYPES].join(', ')}.`);
  const move = { type, freq: Number(freq) };
  if (type.endsWith('Cut')) Object.assign(move, { slope: Number(third ?? 12), q: Number(q ?? 0.71) });
  else Object.assign(move, { gain: Number(third), q: Number(q ?? (type === 'peak' ? 1 : 0.71)) });
  if (Object.values(move).some((v) => typeof v === 'number' && !Number.isFinite(v))) throw new Error(`Bad numbers in ${spec}`);
  return move;
}

/** Rebuilds the evaluation from a saved analysis.json, so suggestions match what the analysis reported. */
function loadEvaluation(file) {
  if (!file) throw new Error('--analysis <analysis.json> is required for --instrument and --correction.');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  return { saved, ev: evaluate(saved.analysis, saved.settings, { reference: saved.reference, file: saved.meta }) };
}

let name = flags.name;
let eq;
const notes = [];
if (flags.correction) {
  const { saved, ev } = loadEvaluation(flags.analysis);
  const current = flags.current ? decodeChannelEq(readFileSync(flags.current)).eq : null;
  const s = suggestMasterEq(ev, { analysis: saved.analysis, current });
  eq = s.eq;
  name ??= CORRECTION_NAME;
  notes.push(`Mode: ${s.mode}${s.unchanged ? ' (no change needed)' : ''}; predicted loudness change before output gain: ${s.loudnessChange.toFixed(1)} dB`, ...s.notes);
} else if (flags.instrument) {
  const { ev } = loadEvaluation(flags.analysis);
  const s = suggestTrackEq(flags.instrument, ev);
  eq = s.eq;
  name ??= `AE ${s.instrument.name}`;
  notes.push(...s.moves.map((m) => `${m.origin}: ${m.type} ${m.freq} Hz${m.gain !== undefined ? ` ${m.gain} dB` : ''} — ${m.reason ?? ''}`), ...s.notes);
} else if (flags.band?.length) {
  const built = buildEq(flags.band.map(parseBand), { maxGain: 24 });
  eq = built.eq;
  if (built.dropped.length) notes.push(`${built.dropped.length} bell(s) dropped: Channel EQ has four bell bands.`);
} else {
  console.error('Give --band …, --instrument <id> or --correction. See the header of this file.');
  process.exit(1);
}
if (!name) throw new Error('--name is required.');
if (flags['output-gain'] !== undefined) eq.outputGain = Number(flags['output-gain']);
eq = normalizeEq(eq);

const dir = flags.dir ?? PRESET_DIR;
const path = join(dir, presetFileName(name));
console.log(`${name}`);
for (const line of eqLines(eq)) console.log(`  ${line}`);
for (const n of notes) console.log(`  · ${n}`);
if (flags['dry-run']) process.exit(0);

mkdirSync(dir, { recursive: true });
const replaced = existsSync(path);
writeFileSync(path, encodeChannelEq(eq));
console.log(`${replaced ? 'Replaced' : 'Wrote'} ${path}`);
console.log("In Logic: open the channel's Channel EQ › Setting menu (top of the plug-in window) › Audio Engineer › choose the preset. Reopen the menu if it isn't listed yet.");
