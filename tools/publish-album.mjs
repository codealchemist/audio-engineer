#!/usr/bin/env node
/**
 * Prepares an album's publishing folders: copies every song's release/<song>.wav to _master/<song>.wav,
 * then encodes each _master/*.wav to _mp3/<name>.mp3 (320 kbps CBR) and _master/flac/<name>.flac (16-bit with
 * TPDF dither, same sample rate). Nothing is copied if a song has no release file. A different file already in
 * _master is never overwritten without --replace. Encoded files older than their master, and FLACs that aren't 16-bit, are encoded again,
 * and only files made in this run are checked. Other files in the folders are reported and left alone.
 *
 *   node tools/publish-album.mjs <album folder> [--dry-run] [--replace]
 * Exit code: 0 done, 1 problem.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { parseFlags } from './lib.mjs';

const MP3_BITRATE = 320;
const MAX_LENGTH_DIFF = 0.1; // seconds between a master and its MP3
const PEAK_WARNING = -0.5; // dBTP; encoding overshoots, and a decoded MP3 above this may clip on playback
const FLAC_BITS = 16;
const FLAC_SAMPLE_RATE = 44100; // with 16-bit, what distributors such as RouteNote require
const MAX_DIFFERENCE = -70; // dBFS; a FLAC's difference from its master should be 16-bit dither noise only

const flags = parseFlags(process.argv.slice(2), { booleans: ['dry-run', 'replace'] });
if (!flags._[0]) {
  console.error('Usage: node tools/publish-album.mjs <album folder> [--dry-run] [--replace]');
  process.exit(1);
}
const album = resolve(flags._[0].replace(/^~(?=\/|$)/, homedir()));
if (!existsSync(album)) throw new Error(`No album folder at ${album}`);

const run = (cmd, args) => {
  const { status, stdout, stderr, error } = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (error) throw new Error(`${cmd}: ${error.message}. Is it installed?`);
  if (status !== 0) throw new Error(`${cmd} failed: ${stderr.trim().split('\n').pop()}`);
  return { stdout, stderr };
};
const probe = (file) => {
  const { stdout } = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,bit_rate:stream=sample_rate,bits_per_sample,bits_per_raw_sample',
    '-of', 'json', file]);
  const { format, streams: [stream] } = JSON.parse(stdout);
  return { duration: Number(format.duration), bitRate: Number(format.bit_rate), sampleRate: Number(stream.sample_rate), bits: stream.bits_per_sample, rawBits: Number(stream.bits_per_raw_sample) };
};
const truePeak = (file) => {
  const { stderr } = run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const peak = stderr.split('True peak:').pop().match(/Peak:\s+(-?[\d.]+|-?inf)/);
  return peak ? Number(peak[1].replace('inf', 'Infinity')) : NaN;
};
const differencePeak = (a, b) => { // dBFS peak of a minus b; a stereo pair is expected
  const { stderr } = run('ffmpeg', ['-hide_banner', '-nostats', '-i', a, '-i', b, '-filter_complex',
    '[0:a]aformat=sample_fmts=dblp[a];[1:a]aformat=sample_fmts=dblp[b];[a][b]amerge=inputs=2,pan=stereo|c0=c0-c2|c1=c1-c3,astats=measure_perchannel=none:measure_overall=Peak_level',
    '-f', 'null', '-']);
  const peak = stderr.split('Overall').pop().match(/Peak level dB:\s+(-?[\d.]+|-?inf)/);
  return peak ? Number(peak[1].replace('inf', 'Infinity')) : NaN;
};
const sameFile = (a, b) => statSync(a).size === statSync(b).size && readFileSync(a).equals(readFileSync(b));
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
const wavsIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav')).sort() : []);

const songs = readdirSync(album)
  .filter((name) => !name.startsWith('_') && existsSync(join(album, name, `${name}.logicx`)))
  .sort();
if (!songs.length) throw new Error(`No song folders in ${album}. A song folder holds <folder name>.logicx.`);

const masterDir = join(album, '_master');
const mp3Dir = join(album, '_mp3');
const flacDir = join(masterDir, 'flac');
const FORMATS = [
  { ext: 'mp3', dir: mp3Dir, args: ['-c:a', 'libmp3lame', '-b:a', `${MP3_BITRATE}k`, '-id3v2_version', '3'] },
  { ext: 'flac', dir: flacDir, args: ['-af', `aresample=osf=s${FLAC_BITS}:dither_method=triangular`, '-c:a', 'flac', '-sample_fmt', `s${FLAC_BITS}`, '-compression_level', '8'] },
];
const dryRun = flags['dry-run'];

// Check everything first, so a problem leaves the folders untouched.
const problems = [];
const toCopy = [];
let upToDate = 0;
for (const song of songs) {
  const source = join(album, song, 'release', `${song}.wav`);
  const target = join(masterDir, `${song}.wav`);
  if (!existsSync(source)) problems.push(`${song}: no release/${song}.wav`);
  else if (!existsSync(target)) toCopy.push({ song, source, target });
  else if (sameFile(source, target)) upToDate++;
  else if (flags.replace) toCopy.push({ song, source, target });
  else problems.push(`${song}: _master/${song}.wav differs from the release file (--replace overwrites it)`);
}
if (problems.length) {
  console.error(`Nothing changed. ${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}

if (!dryRun) { mkdirSync(masterDir, { recursive: true }); for (const { dir } of FORMATS) mkdirSync(dir, { recursive: true }); }
for (const { song, source, target } of toCopy) {
  if (dryRun) { console.log(`would copy    ${song}.wav`); continue; }
  copyFileSync(source, target);
  if (!sameFile(source, target)) throw new Error(`Copy of ${song}.wav doesn't match its release file.`);
  console.log(`copied        ${song}.wav`);
}

const names = [...new Set([...wavsIn(masterDir), ...toCopy.map(({ song }) => `${song}.wav`)])].sort();
let encoded = 0, warnings = 0;
const made = [];
for (const wav of names) {
  const name = basename(wav, '.wav');
  const source = join(masterDir, wav);
  const copying = toCopy.some(({ song }) => `${song}.wav` === wav);
  for (const { ext, dir, args } of FORMATS) {
    const output = join(dir, `${name}.${ext}`);
    const wrongDepth = ext === 'flac' && existsSync(output) && probe(output).rawBits !== FLAC_BITS;
    if (existsSync(output) && !copying && !wrongDepth && statSync(output).mtimeMs >= statSync(source).mtimeMs) continue;
    encoded++;
    if (dryRun) { console.log(`would encode  ${name}.${ext}`); continue; }
    const temp = join(dir, `.${name}.partial.${ext}`); // a stopped encode must not look like a finished file
    try {
      run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-map', '0:a', '-map_metadata', '-1', ...args, temp]);
      renameSync(temp, output);
    } finally {
      rmSync(temp, { force: true });
    }
    made.push({ name, ext, source, output });
    console.log(`encoded       ${name}.${ext}`);
  }
}

const rows = [];
for (const { name, ext, source, output } of made) {
  const master = probe(source);
  const file = probe(output);
  const issues = [];
  let detail;
  if (Math.abs(master.duration - file.duration) > MAX_LENGTH_DIFF) issues.push(`length differs from master by ${Math.abs(master.duration - file.duration).toFixed(2)} s`);
  if (file.sampleRate !== master.sampleRate) issues.push(`sample rate ${file.sampleRate} Hz vs master ${master.sampleRate} Hz`);
  if (ext === 'mp3') {
    const peak = truePeak(output);
    if (Math.abs(file.bitRate / 1000 - MP3_BITRATE) > 5) issues.push(`bitrate ${Math.round(file.bitRate / 1000)} kbps`);
    if (peak > PEAK_WARNING) issues.push(`true peak ${peak.toFixed(1)} dBTP`);
    detail = `${Math.round(file.bitRate / 1000)} kbps, ${peak.toFixed(1)} dBTP`;
  } else {
    const difference = differencePeak(source, output);
    if (file.rawBits !== FLAC_BITS) issues.push(`${file.rawBits}-bit`);
    if (file.sampleRate !== FLAC_SAMPLE_RATE) issues.push(`${file.sampleRate} Hz, distributors usually require ${FLAC_SAMPLE_RATE} Hz`);
    if (!(difference <= MAX_DIFFERENCE)) issues.push(`differs from master by ${difference.toFixed(1)} dBFS`);
    detail = `${file.rawBits}-bit, difference from master ${difference.toFixed(1)} dBFS`;
  }
  warnings += issues.length;
  rows.push(`${`${name}.${ext}`.padEnd(30)} ${clock(master.duration).padStart(5)}  ${file.sampleRate} Hz  ${detail}${issues.length ? `  WARNING: ${issues.join('; ')}` : ''}`);
}
if (rows.length) console.log(`\n${rows.join('\n')}`);

const extras = [
  ...(existsSync(masterDir) ? readdirSync(masterDir).filter((f) => !f.startsWith('.') && f !== 'flac' && !songs.includes(basename(f, '.wav'))).map((f) => `_master/${f}`) : []),
  ...FORMATS.flatMap(({ ext, dir }) => (existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('.') && !names.includes(`${basename(f, `.${ext}`)}.wav`)).map((f) => `${relative(album, dir)}/${f}`) : [])),
];
if (extras.length) console.log(`\nLeft alone, not from this album's songs: ${extras.join(', ')}`);

console.log(`\n${songs.length} songs: ${toCopy.length} ${dryRun ? 'to copy' : 'copied'}, ${upToDate} already up to date, ${encoded} ${dryRun ? 'to encode' : 'files encoded'}, ${warnings} warning(s).`);
