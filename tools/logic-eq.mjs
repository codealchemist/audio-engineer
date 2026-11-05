/**
 * What Logic's Channel EQ really does with a preset's values, as an equivalent in Mixdown Report's filter model
 * (RBJ biquads). The presets keep the values you see in Logic; the offline tools filter with logicEq(eq), so the
 * search and the simulations hear what Logic will play.
 *
 * Measured on PR10-04-repeat (2026-11-04) by least-squares fitting each track's transfer function from the exported
 * tracks to Logic's bounce (fit error 0.1 dB RMS; frequencies, gains, faders and pans all as set):
 *   - Bells: cuts are narrower than the model, boosts are not (Channel EQ's asymmetric gain–Q coupling).
 *     −8 dB Q1 played as Q 2.18, −5 dB Q1 as Q 1.61, +4 dB Q0.8 as Q 0.84 → cut Q × 10^(|gain|/24).
 *   - High shelf −7 dB Q0.71 played as Q 0.59 (×0.84). Only cut shelves were measured; boosts stay as modelled.
 *   - Low Cut 24 dB/Oct: as modelled.
 */
import { core } from './lib.mjs';

const { cloneEq, PEAK_KEYS } = await core('eq/channel-eq.js');

export const LOGIC_EQ = Object.freeze({ bellCutQPerDb: 1 / 24, shelfCutQ: 0.84 });

export function logicEq(eq, cal = LOGIC_EQ) {
  if (!eq) return eq;
  const out = cloneEq(eq);
  for (const key of PEAK_KEYS) {
    const b = out.bands[key];
    if (b.on && b.gain < 0) b.q *= 10 ** (-b.gain * cal.bellCutQPerDb);
  }
  for (const key of ['lowShelf', 'highShelf']) {
    const b = out.bands[key];
    if (b.on && b.gain < 0) b.q *= cal.shelfCutQ;
  }
  return out;
}
