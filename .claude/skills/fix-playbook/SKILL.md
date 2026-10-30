---
name: fix-playbook
description: An audio engineer's decision rules for turning Mixdown Report findings and tonal-curve deviations into concrete Logic Pro moves on specific tracks. Covers which track is the likely cause, step sizes, preset commands, and what not to do. Use when deciding what to change in the next mix or master iteration.
---

# Fix playbook

## Principles

1. **Cause, not symptom.** Fix the track that causes a problem, not the Stereo Out. A band that's too high usually comes from one
   or two parts. Use the track map in `session.md` (instrument ids) to choose contributors. Solo-listening isn't
   available to you, so use the instrument's typical range (below) and what you can see on Logic's meters and EQ analyzers.
2. **Small, attributable moves.** 1–3 related moves per iteration. Each move is at most half the band's deviation, at most
   3 dB of EQ, at most 2 dB of fader. Several tracks can share a fix (for example −1.5 dB at 300 Hz on guitars *and* pads).
3. **Level before EQ.** If a band is high because one instrument is simply too loud, move its fader.
4. **Cut before boost**, and prefer wide, gentle bells (Q 0.7–1.5) for balance. Narrow cuts (Q 3–5) are for resonances only.
5. **One change of plan at a time.** If an iteration regressed, undo it before trying the next idea.
6. **Don't chase the last 0.5 dB.** Inside tolerance is done. Convergence also needs RMS ≤ 1 dB, so spread small fixes rather than one big one.
7. **Respect the user's sound.** Don't remove their creative effects. If a fix needs that (a heavy distortion, a deliberately dark mix),
   report it and ask.

## Tonal deviations → likely contributors → move

| Band too HIGH | Usual suspects | Move (per iteration) |
| --- | --- | --- |
| Sub 20–60 | kick, bass, 808, synth bass; rumble on everything else | low cut 25–30 Hz on kick/bass; low cut 80–150 Hz on non-bass parts; bass fader −1 dB |
| Bass 60–250 | bass, kick, piano/keys left hand, guitars, pads | bass bell −2 dB at the kick's punch frequency (60–100 Hz, Q 1.5); low cuts at 100–150 Hz elsewhere |
| Low mids 250–500 | guitars, pads, keys, piano, vocals, toms, reverb returns | bell −2 dB at 250–400 Hz, Q 1.2 on 2–3 parts; low cut the reverb returns at 200–300 Hz |
| Mids 0.5–2k | vocals, guitars, snare, piano, brass | bell −2 dB at 700 Hz–1.2 kHz, Q 1.5–2 |
| Upper mids 2–4k | distorted guitars, vocals, synth leads, cymbal attack | bell −1.5 dB at 2.5–3.5 kHz, Q 1.8 on the harshest part |
| Presence 4–8k | hi-hats, cymbals, vocal sibilance, distortion fizz | bell −1.5 dB at 5–7 kHz, or a de-esser on vocals; overheads/hats fader −1 dB |
| Air 8–16k | hats, overheads, bright reverbs, exciters | high shelf −1.5 dB at 10 kHz on cymbals/reverbs |

| Band too LOW | Move |
| --- | --- |
| Sub | bass/808 bell +2 dB at 50 Hz, Q 1.2; check low cuts on kick/bass aren't too high |
| Bass | bass fader +1 dB, or bass bell +2 dB at 80–100 Hz |
| Low mids | relax low cuts on guitars/keys/vocals to 80–100 Hz; bell +1.5 dB at 250–350 Hz on main harmonic parts |
| Mids | lead vocal/instrument fader +1 dB, or bell +1.5 dB at 1–1.2 kHz |
| Upper mids | vocal/lead bell +1.5 dB at 3 kHz, Q 1.2; kick beater +2 dB at 3–4 kHz |
| Presence | high shelf +1.5 dB at 5 kHz on vocal/overheads |
| Air | high shelf +1.5 dB at 10–12 kHz on vocal/overheads/master bus reverb; if the mix file is lossy, bounce WAV first |

Commands:
```
# explicit bands on one track
node tools/make-preset.mjs --name "AE Gtr L lowmid" --band peak:320:-2:1.2
# an instrument's corrective starting point plus fixes for the current deviations
node tools/make-preset.mjs --instrument eguitardist --analysis sessions/<song>/mix/iter-NN/analysis.json --name "AE Gtr L"
node tools/make-preset.mjs --list-instruments
```
Use `--instrument` once per track, early on, when the track has no EQ yet. After that, make small `--band` presets in a
**new** Channel EQ after the existing one, or edit the existing one by hand, and log the values.

## Technical findings

- `clipping`: find the strip or bus whose peak indicator is red during the loudest section. Lower that fader, or the plugin
  output that overloads. Then a Gain plugin first on the Stereo Out if the whole mix is hot.
- `mix-headroom`: lower everything at once with a Gain plugin first on the Stereo Out, by ceil(TP + 6) dB. Balance stays the same.
- `mix-limited`: bypass the limiter or Mastering Assistant on the Stereo Out. If the user insists on mix-bus compression, keep it gentle (≤ 2 dB GR).
- `phase` / `phase-wide`: list the stereo tracks with wideners, chorus, Stereo Spread or two-mic recordings. Reduce the
  widener amount on the most likely one first.
- `low-end-sides`: bass/kick/808 panned centre. Direction Mixer Spread 0 on stereo bass instruments. In the master stage, the
  report suggests a Side-processing low cut, which a preset can't set, so do it by hand (Channel EQ Processing: Side).
- `balance`: compare the pan of hard-panned pairs and the centre elements, and nudge the louder side's fader down 0.5–1 dB.
- `wide` / `narrow` / `ref-width`: change widener amounts and pan positions of supporting parts only.
- `lra-low` / `lra-high`: notes. Automation is a creative call: propose it to the user rather than writing automation unasked.

## Mastering moves

The `master-loop` skill has the order. The rule of thumb: loudness comes from limiter Gain, tone comes from updating the single
"Mixdown correction" EQ (never stacking), and dynamics come from the compressor threshold. Never boost the limiter into a PLR under 7 dB just to hit a number.
