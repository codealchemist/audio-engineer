---
name: publish-album
description: Prepare a finished album's publishing folders. Copies every song's approved master to _master/<song>.wav at the album root and encodes each one to _mp3/<song>.mp3 (320 kbps) and _master/flac/<song>.flac (16-bit). Use when the user asks to publish, prepare, package or export an album, to convert its masters to FLAC or MP3, or to fill its _master, _master/flac or _mp3 folders.
---

# Publishing an album

Run this after the album's tracks are released (`album` skill, `master-loop` › Release copy). The album's folder and each
track's status are in `sessions/album.md`. If the user names another album, use that folder instead.

```
<album folder>/_master/PR09-01-randomness.wav         exact copy of PR09-01-randomness/release/PR09-01-randomness.wav
<album folder>/_master/flac/PR09-01-randomness.flac   16-bit with TPDF dither, same sample rate as the WAV in _master
<album folder>/_mp3/PR09-01-randomness.mp3            320 kbps CBR, encoded from the WAV in _master
```

## Steps

1. Read `sessions/album.md`. If a track isn't `released` or `released (before AE)`, tell the user which one and ask before
   going on. Its release file may be missing or out of date.
2. Preview it: `node tools/publish-album.mjs "<album folder>" --dry-run`. It lists what it would copy and encode, and stops if a
   song has no release file or a file in `_master` differs from its release file.
3. If a file in `_master` differs, ask the user before running with `--replace`. It overwrites that master, and there's no backup.
4. Run it without `--dry-run`. Each copy is checked against its release file. Each MP3 is checked for length, sample rate,
   bitrate and true peak. Each FLAC is checked for bit depth and sample rate, and its difference from the master must be only dither noise. The final table lists the files made in this run.
5. Report the table, the warnings and anything the tool left alone. Tell the user the MP3s and FLACs have no title, artist or
   album tags.

## Rules

- `<song>` is the song folder's name, the one that holds `<song>.logicx`. Folders starting with `_` are skipped.
- Never edit the masters, and never change a release file here. If a master needs fixing, go back to `master-loop`.
- The tool never deletes anything. It reports other files in `_master`, `_master/flac` and `_mp3`; ask before removing any.
- An MP3 or FLAC older than its master is encoded again, so re-running after a `--replace` brings both folders up to date. So is a FLAC that isn't 16-bit.
- The WAVs in `_master` stay at their original bit depth (usually 24-bit). Only the FLACs are 16-bit.
- A true peak warning (above −0.5 dBTP) means the MP3 may clip when decoded. Report it to the user. Don't change the file.
