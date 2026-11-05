---
name: album-cover
description: Propose album covers from the album title and song names. Analyzes themes and mood, writes 3 distinct cover concepts with a rationale and an image prompt each, and generates 4 variations per concept (12 images, 1024×1024 PNG) into <album folder>/_cover/, with Gemini in Chrome (default) or an image API (tools/album-cover.mjs). Use when the user asks for an album cover, artwork, cover art or cover ideas, or wants more variations of a cover concept.
---

# Proposing album covers

The user picks one image and upscales it in another tool, so 1024×1024 is the final size here. Nothing in this skill
touches audio, masters, release files or the Logic project.

```
<album folder>/_cover/concepts.json                  the 3 concepts: title, rationale, prompt, 4 variations
<album folder>/_cover/concepts.md                    the same, for reading
<album folder>/_cover/01-<id>/<id>-v1.png … v4.png   1024×1024 PNG
<album folder>/_cover/01-<id>/sheet.png              the concept's 4 images side by side
<album folder>/_cover/contact-sheet.png              all 12, one row per concept
<album folder>/_cover/prompts.json                   the exact prompt, provider and model behind every image
```

## Steps

1. **Gather the names.** Read `sessions/album.md` for the album folder, artist (in the heading) and genre. The album title is
   the folder name without its `PRnn-` prefix (`PR10-power-lifting` → "Power Lifting"); the song names are the song folders
   without the `PRnn-nn-` prefix (`PR10-03-pump` → "Pump"). If the user names another album or gives the titles, use those.
   Ask for the title if the folder name is only a code.
2. **Analyze.** In a few lines: what the title and songs say together (a story, a progression, a pun, a contrast), the
   artist name, the genre and the mood the masters suggest. Note words that work as images and ones that are only abstract.
3. **Write 3 concepts that differ in kind**, not 3 takes on the same picture. A useful spread:
   - **literal**: an object or scene straight from the title, shot or painted so it looks like a record, not stock art;
   - **graphic**: a bold, simple, typographic-free design (shape, pattern, motion, repetition) that reads at thumbnail size;
   - **conceptual**: a surreal or symbolic image that plays on the song names or the artist name.
   For each: an `id` (kebab-case), a `title`, a 2–3 sentence `rationale` (which titles it draws on and why it fits the
   genre), a `prompt` (subject, composition, lighting, palette, medium), and 4 `variations` that change one real thing
   each (angle, palette, medium, framing), not just "another one". Put words shared by all 12 in `style`.
4. **Write `_cover/concepts.json`** (format in the header of `tools/album-cover.mjs`) and a short `concepts.md`, and show the
   user the 3 concepts. Go on unless they want changes; regenerating costs money.
5. **Pick the generator.** The user's choice is **Gemini in Chrome** (route A, below). Use the API route (B) only if they
   ask for it or Claude in Chrome isn't connected.
6. **Generate** 4 images per concept, then build the contact sheets (route B builds them itself).

### Route A: Gemini web app through Claude in Chrome (default, no API key)

The user is signed in to gemini.google.com in their Chrome. Load the `chrome-browser` skill and work in a new tab.

1. Write `_cover/<NN>-<id>/prompts.md` for each concept: rationale, then one fenced prompt per variation. Each prompt starts with
   "Generate a square 1:1 image, 1024×1024." and is `prompt + variation + style`.
2. For each image: open `https://gemini.google.com/app` (a fresh chat, so earlier images don't steer it), focus the input
   with `document.querySelector('[contenteditable=true]').focus()`, type the prompt, press Return and wait about 30 s.
   Hover the image and take a screenshot to check it.
3. **Save it with Gemini's Copy image button** (the middle of the three icons on the image's top right; it shows "Copied to
   clipboard"), then run `tools/clip-image.sh "<album folder>/_cover/<NN>-<id>/<id>-vN.png"`. This writes a 1024×1024 PNG
   with no dialog. It overwrites the user's clipboard, so say so.
   - **Never click Gemini's download button and never trigger a browser download** (`<a download>`, blobs). Chrome may ask
     where to save each file, and the dialog stops the run until a person clicks. The image host
     (`lh3.googleusercontent.com`) refuses CORS and cookie-less requests, and Gemini's CSP blocks posting to localhost,
     so the clipboard is the only route without dialogs.
   - Clicking the image itself opens Gemini's sketch editor. Press its back arrow (top left) to leave.
4. Once all 12 are saved, build the sheets with ImageMagick: per concept `magick montage -label v1 <id>-v1.png … -tile 4x1
   -geometry 384x384+8+8 -background '#111' -fill '#ddd' sheet.png`, and `contact-sheet.png` with all 12 (`-tile 4x`).

### Route B: image API with tools/album-cover.mjs

`node tools/album-cover.mjs "<album folder>/_cover/concepts.json" --dry-run` lists the 12 prompts and the provider. It reads
`OPENAI_API_KEY` (OpenAI, `gpt-image-1`) or `GEMINI_API_KEY` / `GOOGLE_API_KEY` (Google Imagen, `imagen-4.0-generate-001`,
needs billing) from the environment. If neither is set, ask the user to set one in their shell (`export …` in `~/.zshrc`).
Never ask them to paste the key into chat, and never write it into a file. Run it without `--dry-run` to generate. Each image
is checked and converted to a 1024×1024 PNG. Existing images are kept, so a re-run only fills gaps;
`--only <id> --replace` redoes one concept.
7. **Present.** Open `_cover/contact-sheet.png` with the Read tool to check the set yourself (garbled text, extra limbs,
   anything off-brief), then send it and the 3 `sheet.png` files with `SendUserFile` (display `render`). List each image's
   path with its concept and what its variation changes, and say which ones you'd pick and why. Ask which one to keep, or
   which concept to push further with 4 new variations.

## Rules

- No text in the images by default: prompts say "no text, no letters, no logos" and leave calm space for a title. Image
  models garble lettering; the title is added later. Only put text in a prompt if the user asks for it.
- Don't imitate a living artist's style or an existing album cover, and don't use real people's likenesses or brand names.
- Only the prompts are sent to the image service. Audio stays on this machine.
- Never delete images. A replaced concept goes to a new id (`iron-temple-2`) unless the user says to overwrite it.
- `_cover` starts with `_`, so the `album` and `publish-album` skills ignore it.
- Log the result in `sessions/album.md` under a `## Cover` heading: date, provider, model, the concepts and, once the user
  picks one, the chosen file.
