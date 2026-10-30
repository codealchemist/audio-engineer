#!/usr/bin/env node
/**
 * Makes a copy of a bounce small enough for the browser upload tool (10 MB per upload) so it can be
 * dropped on https://mixdownreport.netlify.app/. Lossless 16-bit FLAC at the original rate first;
 * if that is still too big, the loudest excerpt that fits (picked from short-term loudness).
 * An excerpt changes integrated loudness and loudness range, so treat those web readings as approximate;
 * the full-length numbers come from tools/analyze.mjs.
 *
 *   node tools/web-proxy.mjs <bounce.wav> [--out file.flac] [--max-mb 9.5]
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { core, decode, parseFlags } from './lib.mjs';

const flags = parseFlags(process.argv.slice(2));
const input = flags._[0];
if (!input) {
  console.error('Usage: node tools/web-proxy.mjs <bounce.wav> [--out file.flac] [--max-mb 9.5]');
  process.exit(1);
}
const maxBytes = Number(flags['max-mb'] ?? 9.5) * 1024 * 1024;
const out = flags.out ?? join(dirname(input), `${basename(input, extname(input))}.web.flac`);

function encode(start, seconds) {
  const trim = seconds ? ['-ss', String(start), '-t', String(seconds)] : [];
  const res = spawnSync('ffmpeg', ['-v', 'error', '-y', ...trim, '-i', input, '-map', '0:a:0', '-c:a', 'flac', '-sample_fmt', 's16', '-compression_level', '8', out]);
  if (res.status !== 0) throw new Error(`ffmpeg failed: ${res.stderr}`);
  return statSync(out).size;
}

let size = encode(0, 0);
if (size <= maxBytes) {
  console.log(`${out} (${(size / 1048576).toFixed(1)} MB, full length)`);
  process.exit(0);
}

const { channels, sampleRate } = decode(input);
const { measureLoudness } = await core('loudness.js');
const { shortTerm, shortTermStart, shortTermStep } = measureLoudness(channels, sampleRate);
const duration = channels[0].length / sampleRate;
let seconds = Math.floor(duration * (maxBytes / size) * 0.95);
for (let attempt = 0; attempt < 6; attempt++) {
  // Loudest window of `seconds` by mean short-term loudness (in power, so quiet gaps count fairly).
  const n = Math.max(1, Math.round(seconds / shortTermStep));
  const power = shortTerm.map((l) => (Number.isFinite(l) ? 10 ** (l / 10) : 0));
  let best = 0, sum = power.slice(0, n).reduce((a, b) => a + b, 0), bestSum = sum;
  for (let i = n; i < power.length; i++) {
    sum += power[i] - power[i - n];
    if (sum > bestSum) { bestSum = sum; best = i - n + 1; }
  }
  const start = Math.max(0, Math.min(duration - seconds, shortTermStart + best * shortTermStep - 1.5));
  size = encode(start.toFixed(2), seconds);
  if (size <= maxBytes) {
    console.log(`${out} (${(size / 1048576).toFixed(1)} MB, EXCERPT ${start.toFixed(1)}–${(start + seconds).toFixed(1)} s of ${duration.toFixed(1)} s)`);
    process.exit(0);
  }
  seconds = Math.floor(seconds * 0.85);
}
throw new Error('Could not make a copy under the size limit.');
