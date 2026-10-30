#!/usr/bin/env node
/**
 * Lists the tracks a Logic project reveals (recordings and sampler instruments) with a guessed
 * instrument id for make-preset.mjs --instrument. Synth tracks without samples can't be detected.
 *
 *   node tools/logic-tracks.mjs "~/Music/Logic/My Song.logicx"
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { core } from './lib.mjs';

const { parseBinaryPlist } = await core('plist.js');
const { suggestTracksFromMetadata } = await core('logic-project.js');

const project = process.argv[2];
if (!project) {
  console.error('Usage: node tools/logic-tracks.mjs <project.logicx>');
  process.exit(1);
}
const plist = join(project, 'Alternatives', '000', 'MetaData.plist');
if (!existsSync(plist)) throw new Error(`No MetaData.plist at ${plist}. Is this a .logicx package?`);
const { tracks, trackCount, sampleRate, tempo } = suggestTracksFromMetadata(parseBinaryPlist(readFileSync(plist)));
console.log(`Tracks in project: ${trackCount ?? '?'} · Sample rate: ${sampleRate ?? '?'} Hz · Tempo: ${tempo ?? '?'} BPM`);
for (const t of tracks) console.log(`${t.name.padEnd(36)} ${String(t.instrumentId ?? '—').padEnd(15)} ${t.source}`);
