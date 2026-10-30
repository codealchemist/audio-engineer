# Audio Engineer

Claude Code skills and tools that turn Claude into an iterative mix and mastering engineer for **Logic Pro**, using
[Mixdown Report](https://mixdownreport.netlify.app/) ([source](https://github.com/codealchemist/mixdown-report)) as the meter.

```
 ┌──────────── Logic Pro ────────────┐        ┌──────── Mixdown Report ────────┐
 │ apply fixes (faders, Channel EQ   │ bounce │ loudness · true peak · PLR/LRA │
 │ presets, plugins) ── ⌘B ──────────┼───────▶│ 7-band curve vs reference      │
 └───────────────▲───────────────────┘  WAV   │ stereo · findings · correction │
                 │ decide (fix-playbook)      └───────────────┬────────────────┘
                 └──────────── not converged ◀────────────────┘
```

The loop ends when the analyzer reports **CONVERGED**: every band within ±2 dB of the reference, an RMS curve
deviation of 1 dB or less, no critical or warning findings, and (when mastering) loudness within ±0.5 LU of the
target with true peak under the ceiling.

## Requirements

- macOS with Logic Pro, and Claude Code with computer use enabled (to operate Logic)
- Node.js 24+ and ffmpeg (`brew install ffmpeg`)
- A checkout of mixdown-report at `~/dev/mixdown-report`, or `MIXDOWN_REPORT_DIR=/path`. The tools import its analysis core
  directly, so the numbers match the web app exactly.
- Claude in Chrome (optional) for checking results in the web app

## Use

Open your song in Logic Pro, put a reference track in `references/`, start Claude Code in this folder and say, for example:

> Mix the open Logic session toward references/ref.wav, genre rock, target streaming.

Then, once the mix has converged:

> Master it for streaming.

See [CLAUDE.md](CLAUDE.md) for the skills and tools, and `.claude/skills/*/SKILL.md` for the details.

## Tools

```bash
node tools/analyze.mjs sessions/song/bounces/mix.wav --ref references/ref.wav --stage mix --session sessions/song/mix --changes "baseline"
node tools/make-preset.mjs --name "AE Pads" --band lowCut:150:18 --band peak:320:-2:1.2
node tools/make-preset.mjs --instrument leadvocal --analysis sessions/song/mix/iter-03/analysis.json
node tools/make-preset.mjs --correction --analysis sessions/song/master/iter-02/analysis.json --current "<old Mixdown correction.pst>"
node tools/logic-tracks.mjs "~/Music/Logic/Song.logicx"
node tools/wait-bounce.mjs sessions/song/bounces/mix.wav --since 1761750000000
node tools/web-proxy.mjs sessions/song/bounces/mix.wav
```

Presets are written to `~/Music/Audio Music Apps/Plug-In Settings/Channel EQ/Audio Engineer/` (override with `AE_PRESET_DIR`).
