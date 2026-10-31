---
name: publish-album
description: Prepare a finished album's publishing folders. Copies every song's approved master to _master/<song>.wav at the album root and encodes each one to _mp3/<song>.mp3 (320 kbps). Use when the user asks to publish, prepare, package or export an album, or to fill its _master or _mp3 folders.
---

# Publishing an album

Run this after the album's tracks are released (`album` skill, `master-loop` › Release copy). The album's folder and each
track's status are in `sessions/album.md`. If the user names another album, use that folder instead.

```
<album folder>/_master/PR09-01-randomness.wav   exact copy of PR09-01-randomness/release/PR09-01-randomness.wav
<album folder>/_mp3/PR09-01-randomness.mp3      320 kbps CBR, encoded from the file in _master
```

## Steps

1. Read `sessions/album.md`. If a track isn't `released` or `released (before AE)`, tell the user which one and ask before
   going on. Its release file may be missing or out of date.
2. Preview it: `node tools/publish-album.mjs "<album folder>" --dry-run`. It lists what it would copy and encode, and stops if a
   song has no release file or a file in `_master` differs from its release file.
3. If a file in `_master` differs, ask the user before running with `--replace`. It overwrites that master, and there's no backup.
4. Run it without `--dry-run`. Each copy is checked against its release file. Each MP3 is checked for length, sample rate,
   bitrate and true peak, and the final table lists them.
5. Report the table, the warnings and anything the tool left alone. Tell the user the MP3s have no title, artist or album tags
   and the masters are the bounces as they are (usually 24-bit). A distributor such as RouteNote may need 16-bit FLAC, which
   comes from the web app's Release tab.

## Rules

- `<song>` is the song folder's name, the one that holds `<song>.logicx`. Folders starting with `_` are skipped.
- Never edit the masters, and never change a release file here. If a master needs fixing, go back to `master-loop`.
- The tool never deletes anything. It reports other files in `_master` and `_mp3`; ask before removing any.
- An MP3 older than its master is encoded again, so re-running after a `--replace` brings `_mp3` up to date.
- A true peak warning (above −0.5 dBTP) means the MP3 may clip when decoded. Report it to the user. Don't change the file.
