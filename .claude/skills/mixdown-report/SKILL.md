---
name: mixdown-report
description: Measure a bounce with Mixdown Report, either headless with tools/analyze.mjs (same code as the web app) or in the web app at https://mixdownreport.netlify.app/ through Claude in Chrome. Explains the metrics, finding ids, tolerances and how convergence is judged. Use whenever a bounce needs analyzing or a report needs reading.
---

# Mixdown Report

Source: https://github.com/codealchemist/mixdown-report (local checkout: `$MIXDOWN_REPORT_DIR`, default `~/dev/mixdown-report`).
Its `src/core/` is pure JavaScript with no DOM. The web app runs it in a Worker, and `tools/analyze.mjs` runs the same
modules in Node, so both give the same numbers for the same file.

## How it works (what you are optimizing)

- **Loudness:** integrated LUFS (BS.1770-4 gating), true peak (4x oversampled), LRA, PLR = true peak − integrated.
- **Tonal balance:** a long-term third-octave spectrum averaged into 7 bands: Sub 20–60, Bass 60–250, Low mids 250–500,
  Mids 0.5–2k, Upper mids 2–4k, Presence 4–8k, Air 8–16.5k. The comparison is the reference track's bands, or a genre curve.
  Deviations are **median-aligned**, so only shape counts, not level. Tolerance is ±2 dB against a reference and ±3 dB
  against a genre curve. More than tolerance + 4 dB is `critical`.
- **Stereo:** correlation (overall and below 120 Hz), side vs centre width (−18 to −3 dB is normal), L/R balance (±1 dB).
- **Stage** changes the rules. `mix` checks headroom (true peak ≤ −1 dBTP, ideally −6 to −3) and PLR ≥ 9 dB (not limited).
  `master` checks loudness ±1 LU of the target, true peak ≤ the ceiling, and PLR ≥ 7 dB.
- **Correction EQ:** half of each tonal difference (≤ 3–4 dB per filter), fitted so overlapping filters don't stack,
  with an output gain that keeps loudness. When a correction is already in the bounce, the suggestion **replaces** it.

Finding ids: see `references/findings.md`. Thresholds live in `src/core/profiles.js` › `THRESHOLDS`.

## Headless (every iteration)

```
node tools/analyze.mjs <bounce.wav> --ref <ref.wav> --stage mix|master --genre <g> --target <t> \
  --session sessions/<song>/<stage> --changes "<what changed>" [--current-correction <pst>] [--json]
```
The output has the plain-text report (same text as the web app's "Copy report"), the suggested correction EQ, a
**CONVERGENCE** block with checks and a score (lower is better), and with `--session`, a **CHANGE SINCE ITERATION** block.
Iterations are saved as `iter-NN/analysis.json` and `report.txt`, and a row is added to `log.md`.
`--max-dev` and `--max-rms` tighten or loosen the curve goals (defaults: the tolerance, and 1 dB RMS).

## Web app (baseline, final, and spot checks)

Use **Claude in Chrome** (load `anthropic-skills:chrome-browser`; its `file_upload` tool can fill a file input).
The built-in browser can't upload files.

1. Upload size limit is 10 MB per call. Make an upload copy:
   `node tools/web-proxy.mjs <bounce.wav>` → `<bounce>.web.flac`. It's lossless and full length when it fits;
   otherwise it's the loudest excerpt, and the tool says `EXCERPT`. With an excerpt, integrated loudness and LRA in the
   web app are approximate; trust the headless numbers. Do the same for the reference if it's over 10 MB.
2. Open `https://mixdownreport.netlify.app/#files` in a new tab.
3. `find` "Your mix" file input (`#fileMix`), then `file_upload` with the proxy path. For the reference, use `#fileRef`.
   Never click a file input: that opens a native picker.
4. Set **Stage** (`#stage`), **Genre** (`#genre`) and **Release on** (`#target`) with `form_input`.
5. Wait until the status line (`#status`) stops saying it's analyzing. Then read:
   - `#analysis`: the meters plus the band chips (`#bands`). Take a screenshot of the tonal-balance chart for the user.
   - `#fixes`: `What to fix` (`#recs`) and the mastering chain (`#chain`).
   - `#eq`: the suggested correction EQ.
6. Cross-check against `analysis.json`: integrated, true peak and band deviations should agree within about 0.1 dB
   (more with an excerpt). If they don't, say so, and trust the full-length headless run.
7. On later iterations, upload the new proxy again rather than clicking "Reload mix": an uploaded file is a snapshot, not a link to the file on disk.

Audio dropped on the site is analyzed in the browser and never leaves the machine. Downloads (presets, masters,
release files) need the user's OK each time. Prefer `tools/make-preset.mjs`, which writes the same presets locally.
