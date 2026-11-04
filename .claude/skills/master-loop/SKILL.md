---
name: master-loop
description: Iteratively master the song open in Logic Pro on its Stereo Out, using Mixdown Report's master stage. Covers the correction EQ, glue compressor and Adaptive Limiter, and repeats bounce and analysis until loudness, true peak and tonal balance hit the target. Use after the mix has converged, or when the user asks to master or to hit a loudness target.
---

# Master loop (stage: master)

Mastering works on the Stereo Out of a mix that has already converged (`mix-loop`). If the mix still has
`critical` findings, or tonal deviations above about 4 dB, go back to the mix: mastering EQ stays gentle.

Related skills: `logic-pro`, `mixdown-report`, `fix-playbook`.

## 0. Set up

1. Confirm the target with the user: `streaming` (−14 LUFS, −1 dBTP), `apple` (−16, −1), `loud` (−9, −0.3) or `club` (−7, −0.3).
2. Save a project alternative `AE master start`.
3. Build the Stereo Out chain in this order, after anything the user already has there (`logic-pro` › Inserts):
   1. **Channel EQ "Mixdown correction"**: `node tools/make-preset.mjs --correction --analysis <latest mix analysis.json>`,
      then load the preset. The preset is also saved as the "current correction" for later updates.
   2. **Compressor**: Vintage VCA, Ratio 2:1, Attack 30 ms, Release Auto, Auto Gain off. Set Threshold for
      1–2 dB of gain reduction in the loudest section (2–3 dB if LRA > 10 LU). Skip it when PLR < 8 dB.
   3. **Adaptive Limiter**: Out Ceiling = the target's true peak, True Peak Detection on, Gain = the chain's suggested start value.
   4. Nothing after the limiter except metering.
4. Bounce path: `sessions/my-song/bounces/master.wav`. Session dir: `sessions/my-song/master`.

**Plan the chain offline first** (saves the extra master bounces): 
```
node tools/master-plan.mjs sessions/my-song/bounces/mix-final.wav --ref references/<ref> --genre <g> --target <t> \
  --name "Mixdown correction - <SONG>" --write [--pre-gain <dB of a Gain plug-in before it>]
```
It fits the correction EQ in a closed loop, simulates it with a true-peak limiter, and prints the Adaptive Limiter Gain for
the target (corrected by the measured 1.2 dB difference to Logic's limiter; above 12 dB the rest goes on the EQ's output gain)
plus the predicted master. Load that preset, set that Gain, bounce once and run `tools/iterate.mjs --stage master`.
On PR10-01…03 the prediction was within 0.2 LU and 0.1 dB RMS of Logic's master. Skip the compressor unless the plan says
the limiter works hard. If the simulated master doesn't converge, fix the mix first.

## 1. Iterate

```
node tools/iterate.mjs sessions/my-song/bounces/master.wav --since <time> --ref references/<ref>.wav --stage master \
  --genre <g> --target <t> --session sessions/my-song/master --bpm <bpm> \
  --current-correction "$HOME/Music/Audio Music Apps/Plug-In Settings/Channel EQ/Audio Engineer/Mixdown correction.pst" \
  --changes "<what changed>"
```

Fix in this order, one kind of change per iteration:
1. `master-true-peak` / `clipping`: lower limiter Gain or confirm True Peak Detection. Never raise the ceiling above the target.
2. Loudness (`master-quiet` / `master-loud`, and the `loudness` check of ±0.5 LU): change Adaptive Limiter **Gain** by the
   difference the report prints. Loudness tracks Gain almost 1:1 until the limiter works hard.
3. `master-crushed` (PLR < 7 dB): reduce Gain 1–2 dB or let the compressor do more, and accept a quieter master for
   `streaming`. Platforms turn loud masters down anyway. Tell the user about the trade-off.
4. Tonal balance: **update** the correction EQ, never stack another one:
   `node tools/make-preset.mjs --correction --analysis <latest analysis.json> --current "<path to Mixdown correction.pst>"`,
   then reload the preset in the same `Mixdown correction` Channel EQ. A preset load replaces all of its settings.
   If a band still needs more than about 3 dB, stop and go back to the mix.

**Converged** when the analyzer says `CONVERGED`: tonal goals as in the mix stage, no critical or warning findings,
integrated within ±0.5 LU of the target and true peak at or below the ceiling. The stop rules are the same as `mix-loop`
(10 iterations, or 2 stalled or regressed iterations in a row).

## 2. Optional comparisons

- **Logic's Mastering Assistant**: the report's last line suggests a character. Bypass your chain, bounce with the
  Assistant to `master-ma.wav`, analyze it, and compare at matched loudness. Only ask the user to choose if both converge.
- **Master in the browser** (web app › Master tab) gives a second opinion on tone and loudness. Its result stays in
  the browser; downloading it needs the user's OK, and it isn't the Logic master.

## 3. Hand-off

Save the alternative `AE master final`, keep `bounces/master-final.wav`, and summarize: the target vs achieved
loudness, true peak, PLR, LRA, tonal deviations, and the final settings of every plugin on the Stereo Out.
For distribution files, point to the web app's Release tab (FLAC/MP3 for RouteNote). It runs on the user's own
machine; ask before downloading anything.

## 4. Release copy (after the user approves the master)

Only once the user says the master is approved:

1. The release folder is `release/` next to the project's `.logicx` (e.g. `…/PR09-02-timeless/release/`), and the file is
   named after the project: `<project name>.wav` (`PR09-02-timeless.wav`). Create the folder if it doesn't exist.
2. If a file with that name is already there, copy it to `sessions/<song>/backup/release-<name> (<its date and time>).wav`
   first. It may be a master made before this work.
3. Copy `bounces/master-final.wav` over it and check it with `cmp`. The file stays the 24-bit WAV bounce; `publish-album`
   makes the album's FLAC and MP3 files from it.
4. Log the source iteration, destination and backup in `sessions/<song>/session.md`.
