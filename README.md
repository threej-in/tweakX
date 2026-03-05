# tweakX (Chrome Extension)

tweakX replaces X/Twitter home timeline cards with custom media-aware cards.

## Requirements
- Google Chrome (or any Chromium browser with extension developer mode)
- Logged in to `https://x.com`

## Install (Load Unpacked)
1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked**.
5. Select the folder: `d:\node\twitter\extension`.
6. Pin **tweakX** from the extensions menu (optional).

## Install From Release ZIP
1. Download `tweakX-v1.0.0.zip` from the repo release.
2. Extract the ZIP to any folder (for example: `D:\tweakX`).
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted extension folder.

## How To Use
1. Open `https://x.com/home`.
2. Click the tweakX icon.
3. Turn **Enable Extension** on.
4. The page reloads automatically and cards are replaced.

## Update To New Version
1. Pull/download latest code.
2. If needed, replace your extracted folder with the new one.
3. Open `chrome://extensions`.
4. Click **Reload** on tweakX.

## Troubleshooting
- If nothing changes on Home: make sure **Enable Extension** is ON in popup.
- If changes do not appear: hard refresh X (`Ctrl+Shift+R`).
- If requests/actions fail: reload the extension and log in to X again.

## Notes
- Works on `https://x.com/*` and `https://twitter.com/*`.
- Settings are saved in `chrome.storage.sync`.
- If X changes APIs/DOM, selectors or request hooks may need updates.
