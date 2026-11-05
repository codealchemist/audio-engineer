---
name: mix-loop
description: Iteratively mix the song open in Logic Pro toward a reference track. Bounce, analyze with Mixdown Report, apply fixes in Logic, then bounce and analyze again until the tonal curve matches the reference and no issues remain. Use when the user asks to mix, fix, balance or "work on" the open Logic session, or to run the mixing stage.
---

# Mix loop (stage: mix)

You are the mix engineer. Logic Pro is the instrument and Mixdown Report is the meter. Every iteration is
**bounce → analyze → decide → apply → log**, and you repeat it until the analyzer reports `CONVERGED`
or a stop rule below fires.

Related skills: `logic-pro` (driving Logic: bounce, mixer, plugins, presets), `mixdown-report`
(analyzer, web app, reading results), `fix-playbook` (what to change for each finding).

## 0. Set up the session (once)

1. Ask for anything you can't find yourself:
   - **Reference track**: a lossless file of a released song in the same style. Copy it into `references/`.
     A lossy reference (MP3/AAC) works, but its Air band reads low; say so.
   - **Genre** (`pop`, `hiphop`, `edm`, `rock`, `acoustic`) and **release target** (`streaming`, `apple`, `loud`, `club`).
     Genre is used only when there's no reference; the target matters in the master stage.
2. Load `anthropic-skills:computer-use` and get access to Logic Pro. Take a screenshot to identify the open project.
3. Pick a song slug (`my-song`) and create `sessions/my-song/session.md` from `templates/session.md`. Fill in the project path,
   reference, settings, the bounce path `sessions/my-song/bounces/mix.wav`, and the track map.
   Use `node tools/logic-tracks.mjs "<project>.logicx"` plus a mixer screenshot for the map: track name → instrument id → current insert chain.
4. **Safety net:** save the project (⌘S), then save a new project alternative named `AE start` (File › Alternatives).
   Never delete tracks, regions or plugins the user put there. Bypass instead of removing, and log it.
5. Make sure the Stereo Out has no limiter, Mastering Assistant or maximizer active for the mix stage. Bypass them and log it.

## 0b. Fast path: search the mix offline (default)

Each in-Logic iteration costs dozens of screenshots and clicks. Do the search locally instead, so Logic only gets the
final moves and one confirming bounce:

1. Bounce the **baseline** in Logic as usual (step 1 below, `--changes "baseline"`).
2. **Export the tracks** (`logic-pro` › Export all tracks) to `sessions/my-song/stems/audio/`: insert plug-ins on,
   Volume/Pan Automation **off**, so each file is the track after its inserts and before fader and pan.
3. `node tools/stem-mix.mjs init sessions/my-song/stems/audio --session sessions/my-song`, then fill in
   `sessions/my-song/stems/plan.json` from the track map: `fader`, `pan`, `mute`, `instrument`, and `eq` for AE EQs already
   on a track (`{ "preset": "AE PR13 Drum" }`). Files of tracks without regions are silent and are skipped.
4. **Match check:** `node tools/stem-mix.mjs match --session sessions/my-song --baseline sessions/my-song/bounces/mix.wav`.
   It must print `MATCH` (tonal shape within 0.5 dB, level within 0.5 LU, balance within 0.3 dB). It also stores the
   bounce's length in the plan (`lengthSeconds`), because Logic exports tracks to the project end. If it doesn't, fix the
   plan (a wrong fader or pan, a muted track) and check for active aux returns: sends to a reverb aux aren't in the files.
   If the mismatch stays, use the in-Logic loop (step 1) for this song and say why.
5. **Search:** `node tools/stem-mix.mjs optimize --session sessions/my-song --ref references/<ref> --genre <g> --prefix "AE <SONG>" --bpm <bpm>`.
   It tries fader, EQ (the Audio Engineer preset library first, then bells, shelves and low cuts that fit each instrument)
   and bass-to-centre pan moves on a fast model, then renders the result and runs the real analyzer on it. It prints the
   apply list (also in `stems/apply.txt`) and writes `stems/plan-next.json`. Read the list as an engineer: reject moves you
   wouldn't make (say so in the log) and rerun with `--max-fader` or `--no-eq` if needed.
6. `node tools/stem-mix.mjs presets --session sessions/my-song` writes the plan's new Channel EQ presets.
7. **Apply the whole list in Logic in one pass** (`logic-pro` › Cheap screen work), log every before/after value in
   `session.md`, bounce once and run `tools/iterate.mjs`. The rebuilt mix predicts the bounce, so it usually converges here.
   If it doesn't, copy `plan-next.json` over `plan.json` (with any differences you made by hand) and search again.

## 1. Iterate

The in-Logic loop: for the baseline bounce, the confirming bounce after the fast path, and songs the match check rejects.

For iteration N:

1. **Bounce** to the same path every time (`logic-pro` › Bounce). Note the time first.
2. **Wait and analyze in one command** (once a screenshot shows Logic is bouncing):
   ```
   node tools/iterate.mjs sessions/my-song/bounces/mix.wav --since <time> --ref references/<ref> --stage mix \
     --genre <g> --session sessions/my-song/mix --bpm <bpm> --changes "<what you changed before this bounce>"
   ```
   It prints about four lines (levels, bands, convergence, worst 8-bar lean) and saves the full report in
   `iter-NN/report.txt`, like `tools/analyze.mjs`. Read the report only when the short version isn't enough.
   The first run is the baseline (`--changes "baseline"`). Exit code 0 means converged.
3. **Check the web app** only when a number surprises you (`mixdown-report` skill).
   The web app and the analyzer run the same code, so a full-length upload should agree within 0.1 dB.
4. **Decide** what to change, using `fix-playbook`. Priorities:
   1. Critical: `clipping`, `phase`, `master-true-peak` (not in mix stage).
   2. Headroom and dynamics: `mix-headroom`, `mix-limited`.
   3. Low end and stereo: `low-end-sides`, `balance`, `phase-wide`, `wide`.
   4. Tonal balance: the band with the biggest |deviation| first, then neighbours.
   5. Notes (`narrow`, `lra-low`, `lra-high`, `ref-width`, `dc-offset`): fix them if cheap, otherwise justify them in the log.

   Make **1–3 related moves per iteration**, so you can tell what each move did. A move is at most half the
   deviation and never more than 3 dB of EQ or 2 dB of fader per iteration. Fix tracks, not the Stereo Out.
5. **Apply** in Logic (`logic-pro` skill). For EQ, prefer generating a preset with `tools/make-preset.mjs`
   and loading it into a Channel EQ, rather than dragging controls. Write down every value before and after.
6. **Log**: the `--changes` text of the next analyze run records what you did. Keep it specific, e.g.
   `Pad 1 + Keys: Channel EQ bell 320 Hz −2 dB Q1.2; Bass fader −1 dB`.
   Also add a line to `session.md` › Change history with the before values, so the change can be undone.
7. Read the delta (`CHANGE SINCE ITERATION`):
   - `improving`: keep going.
   - `stalled`: the move was too small or on the wrong track. Try a different contributor.
   - `regressed`: undo the last change (restore the logged values) before trying something else.
   - The bounce is `byte-identical`: the export didn't overwrite the file. Fix the bounce, don't analyze it again.

## 2. Converged and stop rules

**Converged** (the analyzer decides, with its default goals):
- every band within the tolerance of the reference (±2 dB, or ±3 dB against a genre curve),
- RMS curve deviation ≤ 1 dB,
- no `critical` and no `warning` findings,
- every remaining `note` explained in the log.

**Stop and report to the user** (don't keep grinding) when:
- 10 iterations have run, or
- 2 iterations in a row are `stalled` or `regressed`, or
- the remaining problem needs a creative decision (re-record, change an arrangement, replace a sample) or
  only a Stereo Out correction would fix it. Offer the final step below.

**Final polish (optional, ask first):** when only small residual tonal differences (≤ 2 dB) are left, add one Channel EQ named
`Mixdown correction` on the Stereo Out, built with `node tools/make-preset.mjs --correction --analysis <latest analysis.json>`.
Bounce and confirm.

## 3. Hand-off

1. Save the project and a new alternative `AE mix final`.
2. Copy the final bounce to `sessions/my-song/bounces/mix-final.wav`.
3. Summarize for the user: the start vs end table (from `log.md`), every change grouped by track, the notes left
   and why, and anything you couldn't fix. Offer the `master-loop` skill next.
