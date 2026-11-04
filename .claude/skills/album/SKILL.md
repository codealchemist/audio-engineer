---
name: album
description: Work through an album one track at a time. Keeps the album folder, shared settings and each track's progress in sessions/album.md, and decides which track is next. Use when the user starts a new album or project, or asks to "continue with the next track", "mix the next track", "master the next track", or asks where the album stands.
---

# Album workflow

An album is a folder with one subfolder per song, numbered in track order, each holding the song's Logic project:

```
<album folder>/PR09-01-randomness/PR09-01-randomness.logicx
<album folder>/PR09-02-timeless/PR09-02-timeless.logicx
…
```

Progress lives in `sessions/album.md` (from `templates/album.md`). It is local and not committed, like the sessions.

## Starting a new album (or project)

1. **Ask for the album folder.** Don't guess it from the open Logic project. Also confirm the shared settings: reference
   track, genre and release target. One reference for the whole album keeps the tracks consistent; an approved track of
   the album makes a good one.
2. List the song folders: subfolders that contain a `<folder name>.logicx`, sorted by name (the number gives the order).
   Ignore folders like `_mp3`.
3. Write `sessions/album.md` with one row per track. A track whose `release/<folder name>.wav` already exists and that
   wasn't processed here is `released (before AE)`.

A different album replaces `sessions/album.md`. Rename the old file to `sessions/album-<album folder name>.md` first.

## One Claude session per track

Start every track in a **fresh session**. A long conversation re-sends its whole history (every screenshot) on each turn, so
the tenth track costs far more than the first. Everything the next track needs is on disk: `sessions/album.md`, the
previous `session.md` files, the skills and `CLAUDE.md`. When a track is finished, propose the next track as a new session
(`start_session`, fresh context, brief "Continue with the next track: <song>") instead of a Continue button in this
session; only stay in the same session if the user asks to.

## "Continue with the next track" / "mix the next track" / "master the next track"

1. Read `sessions/album.md`. The **next track** is the first row in track order whose status isn't `released`.
   For "master the next track" it is the first row with status `mix converged`. Say which track you picked and why.
2. If Logic has a different project open, save it (⌘S), then open the next one with
   `open -a "Logic Pro" "<album folder>/<song>/<song>.logicx"`. Stop and ask if Logic shows a dialog you don't expect
   (missing plugins or sounds, sample rate).
3. Session slug: the folder name in lower case (`pr09-03-seamless`). Use the album's reference, genre and target
   without asking again. All of the track's files go under `sessions/<slug>/`, bounces in `sessions/<slug>/bounces/`
   (`logic-pro` › Each track has its own bounce folder).
4. Run the stage the status calls for:

   | Status | Next step |
   | --- | --- |
   | `todo` | `mix-loop` from set-up |
   | `mixing` | resume `mix-loop` from the session's last iteration |
   | `mix converged` | `master-loop` |
   | `mastering` | resume `master-loop` |
   | `master converged` | ask the user to approve the master |
   | `approved` | `master-loop` › Release copy |

5. Update the track's row whenever its status changes: status, date, and the final numbers (LUFS, dBTP, curve RMS).

## Cleaning up a finished track

Once a track is released, offer to clean up its session folder before moving on, and delete only after the user agrees.
Keep `session.md`, the `mix/` and `master/` logs, `mix-final.wav`, `master-final.wav`, any `backup/release-*` file and
anything the project uses (such as scripts loaded in Logic). Test bounces, A/B clips, alternative masters and web proxies can go.

When every track is released, offer `publish-album` to fill the album's `_master`, `_master/flac` and `_mp3` folders.

"Continue" carries on with the track in progress if there is one. The user decides when to move to the next track,
and creative changes (instrument swaps, expression) are only made when the user asks for them.
