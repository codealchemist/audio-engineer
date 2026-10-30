# Mixdown Report finding ids

From `src/core/evaluate.js`. Severity: critical (fix first) > warning (improve) > note.
The analyzer's convergence requires no critical and no warning findings.

| id | Stage | Severity | Trigger | First move (see fix-playbook) |
| --- | --- | --- | --- | --- |
| `clipping` | both | critical | flat-topped sample runs at peak | find overloading strip/bus; Gain plugin first on Stereo Out |
| `mix-headroom` | mix | warning | true peak > −1 dBTP | Stereo Out fader or Gain plugin down by ceil(TP + 6) dB |
| `mix-limited` | mix | warning | PLR < 9 dB | bypass limiter/Mastering Assistant on Stereo Out |
| `master-quiet` | master | warning | integrated < target − 1 LU | Adaptive Limiter Gain up by the difference |
| `master-loud` | master | note (streaming) / warning | integrated > target + 1 LU | limiter Gain down |
| `master-true-peak` | master | critical | TP > ceiling + 0.1 | Out Ceiling = target, True Peak Detection on, nothing after limiter |
| `master-crushed` | master | warning | PLR < 7 dB | limiter Gain −2…3 dB, more glue compression |
| `lra-low` | both | note | LRA < 3 LU (song > 30 s) | automate verses down 1–2 dB, ease bus compression |
| `lra-high` | both | note | LRA > 14 LU (not acoustic) | volume automation, gentle bus compression |
| `mono-file` | both | note | 1 channel | bounce interleaved stereo |
| `phase` | both | critical | correlation < 0 | mono-check per track, phase invert / nudge, reduce wideners |
| `phase-wide` | both | warning | correlation < 0.2 | reduce Stereo Spread/chorus on pads/synths |
| `low-end-sides` | both | warning | correlation < 0.85 below 120 Hz | centre kick/bass/808, Direction Mixer spread 0 |
| `narrow` | both | note | side < −18 dB vs centre | pan doubles wide, stereo ambience on pads/keys |
| `wide` | both | warning | side > −3 dB vs centre | reduce wideners, centre vocal/kick/snare/bass |
| `balance` | both | warning | L/R differ > 1 dB | centre the core elements, balance hard-panned pairs |
| `dc-offset` | both | note | DC > 0.002 | Low Cut 20 Hz on the offending track |
| `band-<band>-high` / `-low` | both | warning, critical if > tol + 4 | band deviation beyond tolerance | fix-playbook › tonal table |
| `air-lossy` | both | note | air low on a lossy mix file | bounce WAV, don't EQ |
| `ref-width` | both | note | width differs from reference > 4 dB | match wideners/panning |
| `ref-loudness` | master | note | integrated differs from reference > 2 LU | informational; target wins |

Bands: `sub` 20–60 Hz, `low` 60–250, `lowmid` 250–500, `mid` 500–2k, `upmid` 2–4k, `pres` 4–8k, `air` 8–16.5k.
