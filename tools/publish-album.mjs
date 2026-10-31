#!/usr/bin/env node
/**
 * Prepares an album's publishing folders: copies every song's release/<song>.wav to _master/<song>.wav,
 * then encodes each _master/*.wav to _mp3/<name>.mp3 (320 kbps CBR, same sample rate). Nothing is copied
 * if a song has no release file. A different file already in _master is never overwritten without --replace.
 * MP3s older than their master are re-encoded. Other files in both folders are reported and left alone.
 *
 *   node tools/publish-album.mjs <album folder> [--dry-run] [--replace]
 * Exit code: 0 done, 1 problem.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseFlags } from './lib.mjs';

const MP3_BITRATE = 320;
const MAX_LENGTH_DIFF = 0.1; // seconds between a master and its MP3
const PEAK_WARNING = -0.5; // dBTP; encoding overshoots, and a decoded MP3 above this may clip on playback

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
  const { stdout } = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,bit_rate:stream=sample_rate,bits_per_sample',
    '-of', 'json', file]);
  const { format, streams: [stream] } = JSON.parse(stdout);
  return { duration: Number(format.duration), bitRate: Number(format.bit_rate), sampleRate: Number(stream.sample_rate), bits: stream.bits_per_sample };
};
const truePeak = (file) => {
  const { stderr } = run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const peak = stderr.split('True peak:').pop().match(/Peak:\s+(-?[\d.]+|-?inf)/);
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

if (!dryRun) { mkdirSync(masterDir, { recursive: true }); mkdirSync(mp3Dir, { recursive: true }); }
for (const { song, source, target } of toCopy) {
  if (dryRun) { console.log(`would copy    ${song}.wav`); continue; }
  copyFileSync(source, target);
  if (!sameFile(source, target)) throw new Error(`Copy of ${song}.wav doesn't match its release file.`);
  console.log(`copied        ${song}.wav`);
}

const names = [...new Set([...wavsIn(masterDir), ...toCopy.map(({ song }) => `${song}.wav`)])].sort();
let encoded = 0, warnings = 0;
const rows = [];
for (const wav of names) {
  const name = basename(wav, '.wav');
  const source = join(masterDir, wav);
  const mp3 = join(mp3Dir, `${name}.mp3`);
  const copying = toCopy.some(({ song }) => `${song}.wav` === wav);
  if (existsSync(mp3) && !copying && statSync(mp3).mtimeMs >= statSync(source).mtimeMs) continue;
  if (dryRun) { console.log(`would encode  ${name}.mp3`); encoded++; continue; }
  const temp = join(mp3Dir, `.${name}.partial.mp3`); // a stopped encode must not look like a finished MP3
  try {
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-map', '0:a', '-map_metadata', '-1',
      '-c:a', 'libmp3lame', '-b:a', `${MP3_BITRATE}k`, '-id3v2_version', '3', temp]);
    renameSync(temp, mp3);
  } finally {
    rmSync(temp, { force: true });
  }
  encoded++;
  console.log(`encoded       ${name}.mp3`);
}

if (!dryRun) {
  for (const wav of names) {
    const name = basename(wav, '.wav');
    const master = probe(join(masterDir, wav));
    const mp3 = probe(join(mp3Dir, `${name}.mp3`));
    const peak = truePeak(join(mp3Dir, `${name}.mp3`));
    const issues = [];
    if (Math.abs(master.duration - mp3.duration) > MAX_LENGTH_DIFF) issues.push(`length differs from master by ${Math.abs(master.duration - mp3.duration).toFixed(2)} s`);
    if (mp3.sampleRate !== master.sampleRate) issues.push(`sample rate ${mp3.sampleRate} Hz vs master ${master.sampleRate} Hz`);
    if (Math.abs(mp3.bitRate / 1000 - MP3_BITRATE) > 5) issues.push(`bitrate ${Math.round(mp3.bitRate / 1000)} kbps`);
    if (peak > PEAK_WARNING) issues.push(`true peak ${peak.toFixed(1)} dBTP`);
    warnings += issues.length;
    rows.push(`${name.padEnd(30)} ${clock(master.duration).padStart(5)}  ${master.bits}-bit ${master.sampleRate} Hz  MP3 ${Math.round(mp3.bitRate / 1000)} kbps, ${peak.toFixed(1)} dBTP${issues.length ? `  WARNING: ${issues.join('; ')}` : ''}`);
  }
  console.log(`\n${rows.join('\n')}`);
}

const extras = [
  ...(existsSync(masterDir) ? readdirSync(masterDir).filter((f) => !f.startsWith('.') && !songs.includes(basename(f, '.wav'))).map((f) => `_master/${f}`) : []),
  ...(existsSync(mp3Dir) ? readdirSync(mp3Dir).filter((f) => !f.startsWith('.') && !names.includes(`${basename(f, '.mp3')}.wav`)).map((f) => `_mp3/${f}`) : []),
];
if (extras.length) console.log(`\nLeft alone, not from this album's songs: ${extras.join(', ')}`);

console.log(`\n${songs.length} songs: ${toCopy.length} ${dryRun ? 'to copy' : 'copied'}, ${upToDate} already up to date, ${encoded} ${dryRun ? 'to encode' : 'MP3s encoded'}, ${warnings} warning(s).`);
