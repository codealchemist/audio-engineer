#!/usr/bin/env node
/**
 * Waits until Logic has finished writing a bounce: the file must be newer than --since and its size
 * must stop changing. Run it right after confirming the bounce dialog.
 *
 *   node tools/wait-bounce.mjs <bounce.wav> --since <epoch ms | ISO time> [--timeout 900]
 * Exit code: 0 ready, 1 timed out.
 */
import { existsSync, statSync } from 'node:fs';
import { parseFlags } from './lib.mjs';

const flags = parseFlags(process.argv.slice(2));
const file = flags._[0];
if (!file || !flags.since) {
  console.error('Usage: node tools/wait-bounce.mjs <bounce.wav> --since <epoch ms | ISO time> [--timeout 900]');
  process.exit(1);
}
const since = /^\d+$/.test(flags.since) ? Number(flags.since) : Date.parse(flags.since);
const deadline = Date.now() + Number(flags.timeout ?? 900) * 1000;
const STABLE_FOR = 3000; // ms with no size or mtime change

let last = null, stableSince = 0;
const tick = () => {
  if (existsSync(file)) {
    const { size, mtimeMs } = statSync(file);
    const sig = `${size}:${mtimeMs}`;
    if (mtimeMs >= since && size > 44) {
      if (sig !== last) { last = sig; stableSince = Date.now(); }
      else if (Date.now() - stableSince >= STABLE_FOR) {
        console.log(`Ready: ${file} (${(size / 1048576).toFixed(1)} MB, written ${new Date(mtimeMs).toLocaleTimeString()})`);
        process.exit(0);
      }
    }
  }
  if (Date.now() > deadline) {
    console.log(`Timed out: ${file} was not (re)written after ${new Date(since).toLocaleTimeString()}.`);
    process.exit(1);
  }
  setTimeout(tick, 1000);
};
tick();
