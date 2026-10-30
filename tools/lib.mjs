/**
 * Shared helpers: loads Mixdown Report's pure analysis core from its checkout and decodes audio with ffmpeg.
 * The core is the same code the web app runs, so numbers here match https://mixdownreport.netlify.app/.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MIXDOWN_REPORT_DIR = process.env.MIXDOWN_REPORT_DIR ?? join(homedir(), 'dev', 'mixdown-report');
export const PRESET_DIR = process.env.AE_PRESET_DIR
  ?? join(homedir(), 'Music', 'Audio Music Apps', 'Plug-In Settings', 'Channel EQ', 'Audio Engineer');

const LOSSY = new Set(['mp3', 'm4a', 'aac', 'ogg', 'opus', 'webm']);

/** Imports a module from the Mixdown Report core, e.g. core('evaluate.js'). */
export async function core(path) {
  const file = join(MIXDOWN_REPORT_DIR, 'src', 'core', path);
  if (!existsSync(file)) {
    throw new Error(`Mixdown Report core not found at ${file}. Clone https://github.com/codealchemist/mixdown-report there or set MIXDOWN_REPORT_DIR.`);
  }
  return import(pathToFileURL(file).href);
}

function run(cmd, args, maxBuffer = 64 * 1024 * 1024) {
  const res = spawnSync(cmd, args, { maxBuffer });
  if (res.error) throw new Error(`${cmd} failed: ${res.error.message}. Install it with: brew install ffmpeg`);
  if (res.status !== 0) throw new Error(`${cmd} failed: ${res.stderr.toString().trim()}`);
  return res.stdout;
}

/**
 * Decodes up to two channels at the file's own sample rate, like the web app does.
 * @returns {{ channels: Float32Array[], sampleRate: number, meta: { format: string, codec: string, bitDepth: number, lossy: boolean } }}
 */
export function decode(file) {
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
    'stream=sample_rate,channels,codec_name,bits_per_raw_sample,bits_per_sample', '-of', 'json', file]).toString());
  const stream = probe.streams?.[0];
  if (!stream) throw new Error(`${file} has no audio stream.`);
  const sampleRate = Number(stream.sample_rate);
  const total = Number(stream.channels);
  const raw = run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'], 4 * 1024 ** 3);
  const all = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  const frames = Math.floor(all.length / total);
  const used = Math.min(2, total);
  const channels = Array.from({ length: used }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < used; c++) channels[c][i] = all[i * total + c];
  const extension = extname(file).slice(1).toLowerCase();
  return {
    channels,
    sampleRate,
    meta: {
      format: extension.toUpperCase(),
      codec: stream.codec_name,
      bitDepth: Number(stream.bits_per_raw_sample || stream.bits_per_sample) || 0,
      lossy: LOSSY.has(extension),
    },
  };
}

/** Parses --flag value pairs; repeated flags collect into arrays when listed in `multi`. */
export function parseFlags(argv, { multi = [], booleans = [] } = {}) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { flags._.push(arg); continue; }
    const key = arg.slice(2);
    if (booleans.includes(key)) { flags[key] = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    if (multi.includes(key)) (flags[key] ??= []).push(value);
    else flags[key] = value;
  }
  return flags;
}
