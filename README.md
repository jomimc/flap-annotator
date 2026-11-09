# Flap annotator

**Proprietary, all rights reserved. Not open source. Nothing here may be copied, reused, shared or used to train or evaluate any AI system: see `LICENSE`.**

A small web page for marking, frame by frame, the moments in a short video clip of a flying bird when the wings are at their maximum height.
It is a web page that runs in your browser and reads and writes one folder on your computer; nothing is uploaded by the page.

## For the annotator

### What a mark is
A mark is one video frame at which the bird's wings are at **maximum height** (the top of the upstroke, just before the wings start to come down). Mark every such frame you can see in the clip. Do not mark frames where you cannot see the wings well enough to judge (see "Windows" and "Unusable" below).

### Start
1. Download the round folder you were given and unzip it if needed.
2. Open the annotator page (the address you were given) in **Chrome or Edge** on a computer. Firefox and Safari cannot read and write a folder, so the page will only show a message there.
3. Click **Choose round folder**, pick the unzipped round folder, and allow the browser to view and edit its files when it asks.
4. Check the report: the folder name, the number of clips and minutes, that no video or data file is missing, and how many annotations are already there. If it says "not a round folder", you picked the wrong folder (often one level too high or too low); choose a different folder. Then click **Start**.
5. Your marks are saved in a new folder `annotations/` inside the round folder. When you are done, upload the whole round folder back as instructed (see "Saving and sending results back").

If you reload the page you have to pick the folder again; your saved marks are read back from `annotations/`.

### Screen
Left: the video, with a small zoomed inset of the bird (the yellow box comes from an automatic bird detector and may be wrong or missing). Below: a strip (the "lane") covering the whole clip; the white line is the current frame, yellow lines are your marks. Right: the key list and the list of clips with their status.

### Keys
| Key | Action |
|---|---|
| Q / E | one frame back / forward |
| Space | add a mark on the shown frame, or remove the one that is there |
| F | add a mark at the shown frame |
| D | delete the mark nearest the shown frame |
| U | toggle "unsure" on the mark nearest the shown frame |
| K | play / pause |
| 1 2 3 4 | speed 0.1x / 0.25x / 0.5x / 1x |
| N / P | next / previous clip (a changed clip is saved first; if saving fails you stay on the clip) |
| Ctrl+Z | undo (marks, unsure flags, windows) |

### Mouse and buttons
- Click or drag on the strip: jump to that time (when neither Add / Delete nor Move is on).
- **Add / Delete** button on: left click on the strip adds a mark, right click deletes the nearest mark.
- **Move** button on: drag a mark to a new frame (its unsure flag moves with it).
- **Undo**, **Clear all** (removes all marks of the clip; Undo brings them back).
- **Confidence** (high / low) and **Note**: for the whole clip.
- **Save**, **Mark as done** (click again to reopen), **Unusable clip**, **Export all** (downloads one CSV of everything saved in this round).
- Tick **loop clip** to repeat the clip while you work.
- **Zoom**: click and drag on the video to zoom into that part (the rectangle is widened to the shape of the picture); drag again to zoom further. Right click on the video goes back one zoom level; **Reset zoom** goes back to the full picture. A tiny drag does nothing, and zoom resets when you change clip. The small inset is not zoomed.
- Clicking a clip in the list opens it. The header shows the time and frame number and whether the clip has unsaved changes.

### Windows (the part of the clip you could judge)
If the bird is hidden or too small for part of the clip, tick **Edit windows**, click on the strip where the judged part starts, then where it ends. A blue line marks each end and everything outside the windows is greyed. You can add several windows, drag a blue edge to change it, and right click inside a window to remove it (untick the box to go back to normal clicking).
With no window, the whole clip counts as judged. Once there is a window, only the windows count and marks cannot be added outside them. A mark that ends up outside a window (you drew a window afterwards, or dragged the mark) stays on screen in red with a warning, but it is **not saved**; undoing the window brings it back into the saved set.
An empty judged stretch means "no wing-top there"; it is taken as a real answer, so draw windows only around parts you actually looked at carefully.

**Landings.** Wing movements during a landing can be difficult to annotate. If you cannot mark them reliably, leave the landing out: draw a window that ends before the landing begins.

### Unsure and unusable
- **Unsure**: put the cursor frame on a mark and press U. The mark turns pink with a hollow diamond. Use it for a mark you are not confident about. Press U again to undo.
- **Unusable clip**: if the whole clip cannot be judged, click the button; it saves the clip as unusable and done. Click again to undo.
- **Confidence = low** is for a clip you could judge but with doubts overall.

### Saving and sending results back
Changes are saved automatically about 1 second after your last edit, and also when you press Save, Mark as done, Unusable, or move to another clip. The page warns you if you try to leave with unsaved changes. The header says "saved <time>" or "unsaved changes"; a red message means a save failed and your latest changes are not saved yet.
One file per clip is written to `annotations/<clip>.json` inside the round folder you picked (the previous version is kept next to it as `.json.bak`).
Two marks within 2 frames of each other (0.08 s or less) trigger a warning (only a warning; nothing is blocked).
To send results back: when you have finished, upload the whole round folder (with the `annotations/` folder inside it) as instructed. Optionally press **Export all** first and send the downloaded CSV as well. Do not rename the files.

## For the maintainer

### Browser support
The page uses the File System Access API (`window.showDirectoryPicker`, read and write), available in Chrome and Edge (desktop). It is not available in Firefox or Safari; there the page shows a message naming Chrome or Edge. The API needs a secure context: https (e.g. GitHub Pages) or `localhost`. Not tested in Firefox or Safari beyond the unsupported message. The native folder dialog is not covered by the automated test (see Test).

### Requirements
No server and no packages for the annotator: the repository root is a static site (`index.html` redirects to `tool/`), so it can be served by GitHub Pages. Videos should be H.264 mp4 at 25 frames per second (the page assumes `FPS = 25` in `tool/app.js`).
### Test
Serve locally and open the page on localhost (a secure context):

    python3 -m http.server 8000      # from the repository root
    # then open http://localhost:8000/ and pick a round folder

### Building a round folder
    <round>/clips.json
    <round>/clips/<clip_id>.mp4
    <round>/data/<clip_id>.json
    <round>/prior/<clip_id>.json      (optional prior marks)
    <round>/annotations/<clip_id>.json  (written by the page; also <clip_id>.json.bak, ignored when listing)

`clips.json`: `{"clips": [ {clip_id, session, file, data, core:[start,end], clip_start, duration}, ... ]}` where `file` and `data` are paths relative to the round folder (`clips/x.mp4`, `data/x.json`); times are seconds in the source video; the page shows clips in this order. `core` and `clip_start`: see below. `duration` in seconds. The page's round name is the name of the picked folder.

`data/<clip_id>.json` as read by the page: `clip_id`, `session` (shown in the header), `clip_start` (video time of clip frame 0), `duration`, `n_frames` (frame f shows video time `clip_start + f/25`), `core` `[start, end]`, `boxes` (list of `[video_time, x0, y0, x1, y1]` in source-video pixels; use `null` for the four numbers when there is no box; sorted by time; the page interpolates; an empty list hides the inset), `mark_label` (name of the lane, e.g. "Wings at maximum height"). Optional: `exercise`, `event_type` (copied into saved files), `fps` (reported by the loader if not 25), `species` (reported by the loader), `margin`, `video_size`, `instruction`, `colours`, `lanes`, `box_source` (not read by the page).

Prior-marks file (`prior/<clip_id>.json`): read fields `flaps_video_s` (list of mark times, video seconds), `unsure_video_s`, `confidence`, `note`. Other fields are ignored. The "loaded from previous round" label shows only when the prior file has marks. A clip with a saved file in `annotations/` ignores its prior file.
Saved annotation file: see `tool/app.js` function `payload()`: `tool_version`, `round`, `clip_id`, `session`, `clip_start_video_s`, `core_video_s`, `observed_s` (list of `[start,end]`, empty = whole clip), `unusable`, `flaps_video_s`, `unsure_video_s`, `flaps_clip_frame`, `n_flaps`, `n_flaps_in_core`, `confidence`, `note`, `done`, `saved_at`. Marks outside the windows are not saved, and the count fields cover saved marks only.

Keep any key file (tag, lag, bout information) outside this repository; `keys/` is git-ignored.

### Licence
All rights reserved, University of Vienna (see `LICENSE`).
