#!/usr/bin/env node
/**
 * Generates album cover proposals from a concepts file: every concept gets one image per variation (4 by default),
 * each a 1024×1024 PNG, plus a contact sheet per concept and one for the whole set. Only the text prompts leave this
 * machine; no audio is sent anywhere.
 *
 *   node tools/album-cover.mjs <concepts.json> [--out <dir>] [--provider openai|gemini] [--model <id>]
 *                              [--only <concept id>] [--dry-run] [--replace]
 *
 * concepts.json:
 *   { "album": "Power Lifting", "artist": "killing-freud", "style": "shared style words, appended to every prompt",
 *     "concepts": [ { "id": "iron-temple", "title": "Iron Temple", "rationale": "…", "prompt": "…",
 *                     "variations": ["…", "…", "…", "…"] } ] }
 * Each image's prompt is: prompt + variation + style. Without "variations", 4 images come from the same prompt.
 *
 * The API key comes from the environment only: OPENAI_API_KEY (provider openai, default model gpt-image-1) or
 * GEMINI_API_KEY / GOOGLE_API_KEY (provider gemini, default model imagen-4.0-generate-001). With both set, pass --provider.
 * Output (default: the folder that holds concepts.json):
 *   <out>/<NN>-<id>/<id>-v1.png … v4.png, <out>/<NN>-<id>/sheet.png, <out>/contact-sheet.png, <out>/prompts.json
 * Existing images are kept unless --replace. Exit code: 0 done, 1 problem.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseFlags } from './lib.mjs';

const SIZE = 1024;
const PER_CONCEPT = 4;
const PROVIDERS = {
  openai: { env: ['OPENAI_API_KEY'], model: 'gpt-image-1' },
  gemini: { env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], model: 'imagen-4.0-generate-001' },
};

const flags = parseFlags(process.argv.slice(2), { booleans: ['dry-run', 'replace'] });
if (!flags._[0]) {
  console.error('Usage: node tools/album-cover.mjs <concepts.json> [--out <dir>] [--provider openai|gemini] [--model <id>] [--only <id>] [--dry-run] [--replace]');
  process.exit(1);
}
const expand = (p) => resolve(p.replace(/^~(?=\/|$)/, homedir()));
const conceptsFile = expand(flags._[0]);
const spec = JSON.parse(readFileSync(conceptsFile, 'utf8'));
const out = flags.out ? expand(flags.out) : dirname(conceptsFile);
if (!Array.isArray(spec.concepts) || !spec.concepts.length) throw new Error('concepts.json has no "concepts"');

const keyOf = (name) => PROVIDERS[name].env.map((e) => process.env[e]).find(Boolean);
let provider = flags.provider;
if (provider && !PROVIDERS[provider]) throw new Error(`Unknown provider "${provider}". Use openai or gemini.`);
if (!provider) {
  const available = Object.keys(PROVIDERS).filter(keyOf);
  if (available.length > 1) throw new Error(`Keys for ${available.join(' and ')} are set. Pass --provider.`);
  provider = available[0];
}
if (!provider && !flags['dry-run']) {
  console.error('No image-generation key in the environment. Set OPENAI_API_KEY or GEMINI_API_KEY (or run with --dry-run).');
  process.exit(1);
}
const model = flags.model ?? PROVIDERS[provider ?? 'openai'].model;
const key = provider ? keyOf(provider) : undefined;

const run = (cmd, args) => {
  const { status, stdout, stderr, error } = spawnSync(cmd, args, { encoding: 'utf8' });
  if (error) throw new Error(`${cmd}: ${error.message}. Is it installed?`);
  if (status !== 0) throw new Error(`${cmd} failed: ${stderr.trim().split('\n').pop()}`);
  return stdout;
};
const dimensions = (file) => {
  const text = run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  return [Number(text.match(/pixelWidth: (\d+)/)[1]), Number(text.match(/pixelHeight: (\d+)/)[1])];
};

async function post(url, headers, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (res.ok) return res.json();
    const text = (await res.text()).slice(0, 400);
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 5000 * attempt));
      continue;
    }
    throw new Error(`${provider} ${res.status}: ${text}`);
  }
}

/** Returns n PNG buffers for one prompt. */
async function generate(prompt, n) {
  if (provider === 'openai') {
    const json = await post('https://api.openai.com/v1/images/generations', { authorization: `Bearer ${key}` },
      { model, prompt, n, size: `${SIZE}x${SIZE}`, quality: 'high', output_format: 'png' });
    return json.data.map((d) => Buffer.from(d.b64_json, 'base64'));
  }
  const json = await post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`, { 'x-goog-api-key': key },
    { instances: [{ prompt }], parameters: { sampleCount: n, aspectRatio: '1:1' } });
  const images = (json.predictions ?? []).filter((p) => p.bytesBase64Encoded);
  if (!images.length) throw new Error(`gemini returned no image (filtered?): ${JSON.stringify(json).slice(0, 300)}`);
  return images.map((p) => Buffer.from(p.bytesBase64Encoded, 'base64'));
}

const save = (buffer, file) => {
  writeFileSync(file, buffer);
  // Normalize to a 1024×1024 PNG whatever the service returned.
  run('sips', ['-s', 'format', 'png', file, '--out', file]);
  const [w, h] = dimensions(file);
  if (w !== SIZE || h !== SIZE) run('sips', ['-z', String(SIZE), String(SIZE), file]);
  return dimensions(file);
};

const montage = (files, labels, target, tile) => {
  const args = [];
  files.forEach((f, i) => args.push('-label', labels[i], f));
  run('magick', ['montage', ...args, '-tile', tile, '-geometry', '384x384+8+8', '-pointsize', '18', '-background', '#111', '-fill', '#ddd', target]);
};

const concepts = spec.concepts.filter((c) => !flags.only || c.id === flags.only);
if (!concepts.length) throw new Error(`No concept with id "${flags.only}"`);
const log = [];
const failures = [];
mkdirSync(out, { recursive: true });
console.log(provider ? `Provider: ${provider}, model ${model}` : 'Provider: none (no OPENAI_API_KEY, GEMINI_API_KEY or GOOGLE_API_KEY set)');

for (const concept of concepts) {
  const index = spec.concepts.indexOf(concept) + 1;
  const dir = join(out, `${String(index).padStart(2, '0')}-${concept.id}`);
  mkdirSync(dir, { recursive: true });
  const variations = concept.variations?.length ? concept.variations.slice(0, PER_CONCEPT) : Array(PER_CONCEPT).fill('');
  const prompts = variations.map((v) => [concept.prompt, v, spec.style].filter(Boolean).join(' '));
  const files = prompts.map((_, i) => join(dir, `${concept.id}-v${i + 1}.png`));
  console.log(`\n${index}. ${concept.title} → ${relative(process.cwd(), dir) || dir}`);

  const todo = files.map((f, i) => i).filter((i) => flags.replace || !existsSync(files[i]));
  for (const i of files.map((_, k) => k)) {
    const state = todo.includes(i) ? (flags['dry-run'] ? 'would generate' : 'generating') : 'kept';
    const what = variations[i] || prompts[i];
    console.log(`  v${i + 1} ${state}: ${what.slice(0, 140)}${what.length > 140 ? '…' : ''}`);
  }
  if (flags['dry-run']) continue;

  const sameprompt = !concept.variations?.length;
  try {
    if (sameprompt && todo.length) {
      const buffers = await generate(prompts[0], todo.length);
      todo.forEach((i, k) => buffers[k] && save(buffers[k], files[i]));
    } else {
      for (const i of todo) save((await generate(prompts[i], 1))[0], files[i]);
    }
  } catch (err) {
    failures.push(`${concept.id}: ${err.message}`);
    console.error(`  ✗ ${err.message}`);
  }
  const made = files.filter(existsSync);
  for (const f of made) {
    const [w, h] = dimensions(f);
    console.log(`  ✓ ${relative(out, f)} ${w}×${h}`);
  }
  if (made.length) montage(made, made.map((f) => f.match(/-(v\d)\.png$/)[1]), join(dir, 'sheet.png'), `${made.length}x1`);
  log.push({ index, id: concept.id, title: concept.title, rationale: concept.rationale, provider, model,
    images: files.map((f, i) => ({ file: relative(out, f), prompt: prompts[i], exists: existsSync(f) })) });
}

if (!flags['dry-run']) {
  writeFileSync(join(out, 'prompts.json'), `${JSON.stringify({ album: spec.album, artist: spec.artist, generated: new Date().toISOString(), concepts: log }, null, 2)}\n`);
  const all = spec.concepts.flatMap((c, k) => {
    const dir = join(out, `${String(k + 1).padStart(2, '0')}-${c.id}`);
    return Array.from({ length: PER_CONCEPT }, (_, i) => ({ file: join(dir, `${c.id}-v${i + 1}.png`), label: `${k + 1}. ${c.title} v${i + 1}` }));
  }).filter((x) => existsSync(x.file));
  if (all.length) {
    montage(all.map((x) => x.file), all.map((x) => x.label), join(out, 'contact-sheet.png'), `${PER_CONCEPT}x`);
    console.log(`\nContact sheet: ${join(out, 'contact-sheet.png')}`);
  }
}
if (failures.length) {
  console.error(`\n${failures.length} concept(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
