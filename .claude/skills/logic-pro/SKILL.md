---
name: logic-pro
description: How to operate the user's open Logic Pro session through computer use. Covers bouncing to WAV with the right settings, the mixer, faders and pan, inserting plugins, loading Channel EQ presets made by tools/make-preset.mjs, and safety rules. Use whenever a mix or master step has to happen inside Logic Pro.
---

# Operating Logic Pro

Logic Pro has no scripting API for mixing, so you work through **computer use**. Load `anthropic-skills:computer-use` first and
request access to Logic Pro. Screenshot before every click, and screenshot again to confirm the result.
The default key commands below are the usual ones. If a shortcut does nothing, use the menu bar instead.

## Safety rules

- Work only in the project the user has open. Never close it, quit Logic, or open other projects without asking.
- Before the first change, save (⌘S) and save a new project alternative (File › Alternatives), e.g. `AE start`.
- Never delete tracks, regions, plugins or automation. To take a plugin out, **bypass** it (hover the slot, click its
  power button) and log it.
- Keep a written log of each parameter's value **before** you change it (in `sessions/<song>/session.md`).
- Leave the playhead, cycle and markers alone, except to set the bounce range. Restore them afterwards.
- If a dialog appears that you don't understand (sample rate mismatch, missing plugin, save prompt), stop and ask the user.

## Bounce (export the mix to WAV)

1. Check the song range. Logic bounces the cycle area when cycle is on, otherwise from the project start to the end marker.
   Make sure the whole song plus its reverb tail is covered.
2. Note the time (`date +%s000`), then press **⌘B** (File › Bounce › Project or Section).
3. In the bounce dialog (it remembers its settings, so check them the first time, then glance at them):
   - Destination: **PCM** only (MP3, M4A and Burn unticked)
   - File Format **WAVE**, Resolution **24 Bit**, Sample Rate **same as the project**, File Type **Interleaved**
   - Dithering **None**, Normalize **Off**, Mode **Offline** (Realtime only if a plugin needs it), Include Audio Tail on
   - "Add to Project" / "Add to Audio File Browser": off
4. Confirm. In the save panel, press ⇧⌘G, type the folder (e.g. `~/dev/audio-engineer/sessions/<song>/bounces`) and
   the file name (`mix.wav` or `master.wav`). Confirm **Replace** when asked. Overwriting the same name every iteration is intentional.
5. Once a screenshot shows "Bouncing", run `node tools/iterate.mjs <path> --since <time> …` (`mix-loop` › Iterate): it waits for the
   file and analyzes it in one step. `tools/wait-bounce.mjs` alone is for bounces you don't analyze.

**Each track has its own bounce folder** (`sessions/<song>/bounces/`). Logic remembers the last folder across projects, so
the first bounce of a new track opens in the *previous* track's folder. Before that first bounce, point the save panel at
the current track's folder (full-screen control, ⇧⌘G). If it lands elsewhere anyway, move only that file into the current
track's folder right after the bounce. Never leave a track's files in another track's folder.

**The bounce range follows the region selection** (when cycle is off). Before every ⌘B, click empty space in the tracks
area and press ⌘A (or Edit › Select › All), then check Start/End and the time match the baseline (e.g. 1 1 1 1 → 64 1 1 1, 3:09).
A partial selection gives a shorter bounce and makes iterations incomparable.

**Never press ⌘A in a Mixer dB field.** It selects every channel strip instead of the text, and the next typed value then moves all selected faders by the same amount (Stereo Out included). A double-click already selects the field's text: double-click, type, Return. If it happens, use Edit › Deselect All first, because every later edit stays relative while the strips are selected. Don't trust Mixer Undo to put it right, and don't use plain ⌘Z in the Mixer (it can undo a plug-in insert): compare every strip with the logged values and retype what differs, one strip at a time.

**Which control mode to use:** background (`app_*`) control is enough for bypass buttons, faders (double-click the
**inspector's** dB field, `app_type` with `overwrite_existing`, then click elsewhere to commit) and menus. It is *not*
enough for plugin parameters (clicks and scrolls jump or toggle slider values), insert-slot menus, preset menus or the
save panel. For those, ask for full-screen control once (`request_full_control`), then double-click a value, type
it (comma decimal in this locale, e.g. `-1,5`), Return. In full-screen mode ⇧⌘G works in the save panel, and Logic
then remembers the folder for later bounces. Clicking a plugin's **Compare** button restores its last-saved settings,
which is useful for backing out an accidental edit. Prefer a plugin's output gain over the fader on tracks with volume automation.

**Background control caveat:** with the `app_*` tools you can't use ⇧⌘G or the folder pop-up in the save panel, and a typed
path does *not* navigate: Logic saves into the panel's current folder with `/` turned into `:` in the file name.
Instead, type only a distinctive name (`AE-mix`) with `overwrite_existing: true`, let it land in the panel's folder (usually
the project's last bounce folder), then `mv` that file (only the one you created) to `sessions/<song>/bounces/mix.wav`.
Never overwrite or move the user's own bounces. The Stereo Out's plugin bypass buttons are AXCheckBox "bypass"
elements (`app_ax_find title_contains: bypass`), clickable in the background. File › Project Alternatives isn't readable
in the background, so make a backup with `cp -cR <project>.logicx sessions/<song>/backup/` after saving.

## Export all tracks (for `tools/stem-mix.mjs`)

1. Click empty track space, ⌘A, then File › Export › All Tracks as Audio Files (⇧⌘E).
2. In the save panel, ⇧⌘G to `~/dev/audio-engineer/sessions/<song>/stems/audio` (create the folder first with `mkdir -p`).
   Format WAVE, 24 bit, the project's sample rate, Normalize **Off**, Include Audio Tail on,
   **Bypass Effect Plug-ins off** (the files must include the inserts) and **Include Volume/Pan Automation off**
   (the files must exclude fader and pan; `stem-mix.mjs` adds them). The first time, take one screenshot of the dialog and
   record the control positions here.
3. Files start at the project start, so they line up with the bounce. Wait with
   `ls -la sessions/<song>/stems/audio` until the count stops growing (one file per track), not with screenshots.
4. The files show what each track feeds the Stereo Out, except aux returns (reverb sends). `stem-mix.mjs match` checks this.

## Cheap screen work

Screenshots are the most expensive part of a session. To keep a song within budget:
- Apply a whole apply list in **one `computer_batch`** per group of moves (all faders, then all presets), with the positions
  from this skill, and end each batch with one screenshot at `scale: 0.4`, or a `zoom` on just the changed area.
- Don't screenshot between steps whose positions are known. Re-take one only after something moved the layout (a window opened).
- Read values by zooming on small regions (`zoom` with `scale: 0.5`) or with `app_ax_find`, not with full screenshots.
- Check results with tools, not the screen: `tools/iterate.mjs` for bounces, `ls`/`stat` for exported files.

## Mixer and channel strips

- **X** toggles the Mixer. Use the "All" view so buses, auxes and the Stereo Out are visible.
- **Fader:** double-click the dB value above the fader and type the new value, then press Return. Option-click resets it to 0 dB.
  Faders are more precise than dragging.
- **Pan:** double-click the pan knob value, or drag it vertically. Option-click centres it.
- **Mute / Solo:** M / S buttons on the strip. Leave everything unmuted and unsoloed before a bounce.
- Read the strip's **name**, **inserts**, **sends** and **output** from a zoomed screenshot (`zoom` action) before you edit.

## Inserting a plugin

1. Click an empty insert slot on the channel strip, then choose the plugin: EQ › Channel EQ, Dynamics › Compressor,
   Dynamics › Adaptive Limiter, Utility › Gain, Imaging › Direction Mixer.
2. Order matters: add the plugin in the right slot (drag a slot to move it, or hold Option to copy).
3. Name plugins you add for this work where Logic allows it, or record the slot number in the log.

## Loading a Channel EQ preset (fastest way to apply exact EQ)

1. Create the preset: `node tools/make-preset.mjs --name "AE <Track>" --band …` (or `--instrument`, or `--correction`).
   It goes into `~/Music/Audio Music Apps/Plug-In Settings/Channel EQ/Audio Engineer/`.
2. Open the target Channel EQ (double-click its insert slot). If the track already has a Channel EQ that the user set,
   **add a new Channel EQ after it.** Loading a preset replaces every setting of the plugin.
3. In the plugin header, open the **Setting** menu (the preset name, default "Manual"), choose **Audio Engineer** and then the preset.
   If it isn't listed yet, close and reopen the menu or the plugin window.
4. Screenshot the EQ and check that the bands match what the tool printed. Close the plugin window.

The offline tools (`stem-mix.mjs`, `master-plan.mjs`) filter through `tools/logic-eq.mjs`, which models how Channel
EQ really plays a preset (cut bells narrower than their Q: Q × 10^(|gain|/24); cut shelves Q × 0.84), measured on
PR10-04. If a bounce stops matching a rebuilt plan (`stem-mix.mjs match --plan <plan> --baseline <bounce>`), re-measure
and update those constants rather than working around them.

## Other common actions

- **Gain plugin on the Stereo Out** (headroom): Utility › Gain as the first insert, set its Gain to the value the report gives.
- **Mono low end** on a stereo bass track: Direction Mixer with Spread 0, or Gain with Mono on.
- **Compressor:** set Circuit Type, Ratio, Attack, Release and Threshold by double-clicking each value field and typing it.
- **Adaptive Limiter:** Gain, Out Ceiling, True Peak Detection (an Advanced or extended-parameters disclosure in some versions).
- **Undo:** ⌘Z undoes the last edit. To undo a change from earlier, restore the values you logged.

## Finishing

Save (⌘S). At the end of a stage, save a new alternative (`AE mix final`, `AE master final`).
