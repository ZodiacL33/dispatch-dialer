# Dispatch Dialer Assistant (v2)

## One-time setup (Windows)
1. Install Python 3 from python.org (tick "Add Python to PATH").
2. Open this folder in File Explorer, click the address bar, type `cmd`, press Enter.
3. Build your call list (the first run downloads the FMCSA census, a few minutes):
   `python build_queue.py`
   It prints how many carriers each filter removed, then writes `queue.json`.
   If it says a column is missing, run `python build_queue.py --columns` and send me the list.
4. In Chrome open `chrome://extensions`, turn on Developer mode, click "Load unpacked", pick the `extension` folder.
5. Open voice.google.com, sign in, and reload that tab once. Click the extension icon to open the side panel.
6. In the panel click "Load queue.json".

To refresh with newer FMCSA data later, run `python build_queue.py --refresh` and load the new queue.json.
Your history, stats, saved carriers and notes are kept when you load a new queue.

## First-run calibration (do this once, 2 minutes)
Tick **Test mode** in Settings, press Dial. The number should load into Google Voice without calling.
The top-right pill must say "Voice: ready". If it says "cannot read page", the Google Voice button names
differ: change the three patterns in Settings (right-click the button, Inspect, copy its aria-label).
Then untick Test mode.

## Daily use
- **Dial** loads the number into Google Voice and presses Call. Dial is locked while you are on a call.
- **Auto-dial** (checkbox, off by default) dials the next carrier after you hang up, after your chosen delay (3 s minimum).
- **Pause** stops auto-dial instantly. **Skip**, **Copy info** and the result buttons work any time.
- **Min / Max trucks** at the top change live. Min 0 includes carriers FMCSA lists with zero trucks.
- **Start from MC**: type any MC and press Go. Carriers are NOT blocked for having been called before.
  If you jump back into a block you already worked, a new pass starts with its own stats row.

## Repeat calling and saved carriers
- Calling a carrier does not block calling them again later.
- Only carriers you **save** (Lead, Sale, Follow-up, or Do not call) are skipped automatically.
  You can still call them yourself from the Saved carriers list (Open or Call).
- Note, follow-up date and saving are all optional and can be edited later in Saved carriers.
- Marking a call **Do not call** saves the carrier as Do not call, so they are never auto-dialed.
- "Follow-ups due" at the top counts saved follow-ups whose date is today or earlier.

## Stats
One row per block of 10,000 MCs (changeable in Settings) and per pass: calls, picked up, interested, call back.
Rates count only calls you marked, so press a result button after each call. Export stats / call log / saved to CSV.

## Optional live FMCSA check
Get a free webKey at mobile.fmcsa.dot.gov (Login.gov account), paste it in Settings, tick the box.
Before each automatic dial it confirms authority is still active and skips carriers that are not.
If FMCSA does not answer within 6 seconds it dials anyway and tells you. Beta: untested against the live API.

## Filters applied when building the queue
Active USDOT, MC number, authorized, carrier only (no broker or freight forwarder), General Freight ticked,
48 contiguous states (no AK, HI, DC, territories, Canada, Mexico), valid 10-digit US phone (cell field as backup).
MCs FMCSA has no record of, or that are inactive, are simply never in the queue, so nothing waits or times out.
