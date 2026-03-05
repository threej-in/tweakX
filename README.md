# tweakX (Chrome Extension)

## Install
1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this folder: `d:\node\twitter\extension`

## Use
1. Open `https://x.com/home` (or refresh if already open)
2. Wait for HomeTimeline network response
3. The extension replaces native tweet card cells in-place with custom cards
4. Click the extension icon and use:
   - **Enable Extension** to turn replacement on/off

## Notes
- The extension listens for HomeTimeline responses by patching `fetch` and `XMLHttpRequest` in page context.
- `SHOW_TOMBSTONES` is set to `false` in `content.js`, so restricted/tombstone entries are skipped.
- In-place replacement keeps Twitter's normal layout/sentinels so auto infinite-loading loops from `display:none` collapsing are avoided.
- Cards now include:
  - Hover profile panel (name, handle, bio, followers/following, join date)
  - Feedback buttons derived from payload feedback keys (`Not interested`, etc.)
- Settings are persisted in `chrome.storage.sync` (`extensionEnabled`)
- If X changes DOM or endpoint naming, selectors/hook filters may need updates.


