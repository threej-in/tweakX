(() => {
  const BRIDGE_SOURCE = "x-home-timeline-hook";
  const CONTENT_SOURCE = "x-home-timeline-content";
  const STYLE_ID = "x-custom-home-feed-style";
  const EXTENSION_ENABLED_KEY = "extensionEnabled";
  const SHOW_TOMBSTONES = false;
  const FALLBACK_AVATAR =
    "https://abs.twimg.com/sticky/default_profile_images/default_profile_400x400.png";

  let latestCards = [];
  let pendingBatches = [];
  let seenBatchIds = new Set();
  let seenTweetIds = new Set();
  let isExtensionEnabled = true;
  let isGridMode = false;
  let renderTimer = null;
  let feedbackRequestCounter = 0;
  let actionRequestCounter = 0;
  const feedbackResolvers = new Map();
  const actionResolvers = new Map();

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatCount(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return "0";
    return new Intl.NumberFormat("en", { notation: "compact" }).format(number);
  }

  function formatRelativeTime(dateText) {
    if (!dateText) return "now";
    const date = new Date(dateText);
    if (Number.isNaN(date.getTime())) return "now";
    const diffMs = Date.now() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "now";
    if (diffMin < 60) return `${diffMin}m`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h`;
    const diffDays = Math.floor(diffHrs / 24);
    return `${diffDays}d`;
  }

  function formatJoinDate(dateText) {
    if (!dateText) return "";
    const date = new Date(dateText);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en", { month: "short", year: "numeric" }).format(date);
  }

  function toDisplayText(tweet) {
    let text = tweet.legacy?.full_text || "";
    const urls = tweet.legacy?.entities?.urls || [];

    for (const item of urls) {
      if (!item?.url) continue;
      text = text.replaceAll(item.url, item.expanded_url || item.display_url || item.url);
    }

    return text.trim();
  }

  function pickVideoSrc(mediaItem) {
    const variants = mediaItem?.video_info?.variants || [];
    const mp4Variants = variants.filter(
      (variant) => variant?.content_type === "video/mp4" && variant?.url
    );
    if (mp4Variants.length) {
      mp4Variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      return mp4Variants[0].url;
    }

    const hlsVariant = variants.find((variant) => variant?.url);
    return hlsVariant?.url || "";
  }

  function getMediaSourceHandle(mediaItem) {
    const embeddedHandle =
      mediaItem?.additional_media_info?.source_user?.user_results?.result?.core?.screen_name ||
      mediaItem?.additional_media_info?.source_user?.user_results?.result?.legacy?.screen_name ||
      "";
    if (embeddedHandle) return embeddedHandle;

    const expandedUrl = mediaItem?.expanded_url || "";
    const match = expandedUrl.match(/x\.com\/([^/]+)\/status\//i);
    return match?.[1] || "";
  }

  function toProfilePath(handle) {
    const clean = String(handle || "").replace(/^@+/, "").trim();
    if (!clean) return "";
    return `https://x.com/${encodeURIComponent(clean)}`;
  }

  function readCookie(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : "";
  }

  function normalizeFeedbackUrl(feedbackUrl) {
    if (!feedbackUrl) return "";
    if (feedbackUrl.startsWith("http://") || feedbackUrl.startsWith("https://")) return feedbackUrl;
    if (feedbackUrl.startsWith("/i/api/")) return `${window.location.origin}${feedbackUrl}`;
    if (feedbackUrl.startsWith("/2/")) return `${window.location.origin}/i/api${feedbackUrl}`;
    if (feedbackUrl.startsWith("/")) return `${window.location.origin}${feedbackUrl}`;
    return `${window.location.origin}/${feedbackUrl}`;
  }

  function requestFeedbackViaPage(url) {
    return new Promise((resolve) => {
      const requestId = `fb-${Date.now()}-${feedbackRequestCounter++}`;
      const timer = setTimeout(() => {
        feedbackResolvers.delete(requestId);
        resolve({ ok: false, timeout: true });
      }, 8000);

      feedbackResolvers.set(requestId, (result) => {
        clearTimeout(timer);
        feedbackResolvers.delete(requestId);
        resolve(result || { ok: false });
      });

      window.postMessage(
        {
          source: CONTENT_SOURCE,
          kind: "feedback-submit",
          requestId,
          url
        },
        "*"
      );
    });
  }

  function requestActionViaPage(action, tweetId, tweetUrl, meta = {}) {
    return new Promise((resolve) => {
      const requestId = `act-${Date.now()}-${actionRequestCounter++}`;
      const timer = setTimeout(() => {
        actionResolvers.delete(requestId);
        resolve({ ok: false, timeout: true });
      }, 9000);

      actionResolvers.set(requestId, (result) => {
        clearTimeout(timer);
        actionResolvers.delete(requestId);
        resolve(result || { ok: false });
      });

      window.postMessage(
        {
          source: CONTENT_SOURCE,
          kind: "action-submit",
          requestId,
          action,
          tweetId,
          tweetUrl,
          userId: meta.userId || "",
          screenName: meta.screenName || ""
        },
        "*"
      );
    });
  }

  function renderAction(iconPath, count, label, actionKey, tweetId, tweetUrl) {
    return `
      <span class="x-action" role="button" tabindex="0" title="${escapeHtml(
        label
      )}" data-action="${escapeHtml(actionKey || "")}" data-tweet-id="${escapeHtml(
        tweetId || ""
      )}" data-tweet-url="${escapeHtml(tweetUrl || "")}">
        <svg class="x-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="${iconPath}"></path>
        </svg>
        ${count === null ? "" : `<span>${escapeHtml(formatCount(count))}</span>`}
      </span>
    `;
  }

  function renderTombstoneCard(text, entryId) {
    return `
      <article class="x-card x-tombstone" data-has-media="0">
        <span class="x-badge">Restricted</span>
        <p class="x-content">${escapeHtml(text || "This post is not available.")}</p>
        <div class="x-actions"><span>ID: ${escapeHtml(entryId || "n/a")}</span></div>
      </article>
    `;
  }

  function renderFeedbackButtons(feedbackActions) {
    if (!feedbackActions?.length) return "";
    return `
      <div class="x-feedback-row">
        ${feedbackActions
          .slice(0, 3)
          .map((action) => {
            const prompt = action?.prompt || action?.feedbackType || "Feedback";
            const feedbackUrl = action?.feedbackUrl || "";
            return `<button class="x-feedback-btn" data-feedback-url="${escapeHtml(
              feedbackUrl
            )}" title="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>`;
          })
          .join("")}
      </div>
    `;
  }

  function renderTweetCard(tweet, entryId, feedbackActions = []) {
    const userResult = tweet.core?.user_results?.result;
    const userCore = userResult?.core || {};
    const userLegacy = userResult?.legacy || {};
    const media = tweet.legacy?.extended_entities?.media || [];

    const name = userCore.name || "Unknown user";
    const handle = userCore.screen_name ? `@${userCore.screen_name}` : "@unknown";
    const userId = String(userResult?.rest_id || userLegacy?.id_str || "");
    const profilePath = toProfilePath(userCore.screen_name || "");
    const tweetId = String(tweet?.rest_id || tweet?.legacy?.id_str || "");
    const tweetUrl = profilePath && tweetId ? `${profilePath}/status/${tweetId}` : "";
    const avatar =
      userResult?.avatar?.image_url || userLegacy.profile_image_url_https || FALLBACK_AVATAR;
    const content = toDisplayText(tweet) || "[No text content]";
    const time = formatRelativeTime(tweet.legacy?.created_at);
    const joinDate = formatJoinDate(userCore.created_at);
    const bio = userLegacy.description || "";
    const sourceMedia = media.find((item) => {
      if (item.type !== "video" && item.type !== "animated_gif") return false;
      return Boolean(getMediaSourceHandle(item));
    });
    const sourceHandle = sourceMedia ? getMediaSourceHandle(sourceMedia) : "";
    const sourceProfilePath = toProfilePath(sourceHandle);

    const mediaHtml = media.length
      ? `<div class="x-media-grid">${media
          .map((item) => {
            const isVideo = item.type === "video" || item.type === "animated_gif";
            if (isVideo) {
              const videoSrc = pickVideoSrc(item);
              if (!videoSrc) return "";
              const poster = item.media_url_https || item.media_url || "";
              const autoplayAttrs = item.type === "animated_gif" ? " autoplay loop muted" : "";
              const playBadge =
                item.type === "video" ? `<span class="x-video-play" aria-hidden="true"></span>` : "";
              return `<div class="x-media-shell"><video class="x-media-item" src="${escapeHtml(
                videoSrc
              )}" poster="${escapeHtml(
                poster
              )}" controls playsinline preload="metadata"${autoplayAttrs}></video>${playBadge}</div>`;
            }

            const imageSrc = item.media_url_https || item.media_url;
            if (!imageSrc) return "";
            const alt = item.type ? `${item.type} media` : "tweet media";
            return `<div class="x-media-shell"><img class="x-media-item" src="${escapeHtml(
              imageSrc
            )}" alt="${escapeHtml(alt)}" loading="lazy" /></div>`;
          })
          .join("")}</div>`
      : "";

    return `
      <article class="x-card" data-entry-id="${escapeHtml(entryId || "")}" data-tweet-id="${escapeHtml(
      tweet?.rest_id || ""
    )}" data-has-media="${media.length ? "1" : "0"}">
        <header class="x-header">
          <div class="x-avatar-wrap">
            <img class="x-avatar" src="${escapeHtml(avatar)}" alt="${escapeHtml(
      name
    )} avatar" loading="lazy" />
          </div>
          <div class="x-meta">
            <div class="x-meta-line">
              <span class="x-name">${escapeHtml(name)}</span>
              <span class="x-handle">${escapeHtml(handle)}</span>
              <span class="x-dot">&middot;</span>
              <span class="x-time">${escapeHtml(time)}</span>
            </div>
            <div class="x-hover-card" role="tooltip">
              <div class="x-hover-name">${
                profilePath
                  ? `<a class="x-profile-link" href="${escapeHtml(profilePath)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)}</a>`
                  : `${escapeHtml(name)}`
              }</div>
              <div class="x-hover-handle">${
                profilePath
                  ? `<a class="x-profile-link x-handle-link" href="${escapeHtml(profilePath)}" target="_blank" rel="noopener noreferrer">${escapeHtml(handle)}</a>`
                  : `${escapeHtml(handle)}`
              }</div>
              ${
                userId
                  ? `<button class="x-follow-btn" data-action="follow" data-user-id="${escapeHtml(
                      userId
                    )}" data-screen-name="${escapeHtml(
                      userCore.screen_name || ""
                    )}" title="Follow ${escapeHtml(handle)}">Follow</button>`
                  : ""
              }
              ${bio ? `<p class="x-hover-bio">${escapeHtml(bio)}</p>` : ""}
              <div class="x-hover-stats">
                <span><strong>${escapeHtml(formatCount(userLegacy.following_count || userLegacy.friends_count))}</strong> Following</span>
                <span><strong>${escapeHtml(formatCount(userLegacy.followers_count))}</strong> Followers</span>
                ${joinDate ? `<span>Joined ${escapeHtml(joinDate)}</span>` : ""}
              </div>
            </div>
          </div>
          <span class="x-menu" aria-hidden="true">...</span>
        </header>

        <p class="x-content">${escapeHtml(content)}</p>
        ${mediaHtml}
        ${
          sourceHandle
            ? `<div class="x-media-credit">From ${
                sourceProfilePath
                  ? `<a class="x-source-link" href="${escapeHtml(sourceProfilePath)}" target="_blank" rel="noopener noreferrer">@${escapeHtml(sourceHandle)}</a>`
                  : `<span>@${escapeHtml(sourceHandle)}</span>`
              }</div>`
            : ""
        }

        <div class="x-actions">
          ${renderAction(
            "M1.75 11.5c0-4.56 3.72-8.25 8.25-8.25h6.5a6.75 6.75 0 0 1 0 13.5H9c-4.53 0-8.25-3.69-8.25-8.25Zm8.25-6.75a6.75 6.75 0 0 0 0 13.5h6.5a5.25 5.25 0 0 0 0-10.5H9Z",
            tweet.legacy?.reply_count,
            "Replies",
            "reply",
            tweetId,
            tweetUrl
          )}
          ${renderAction(
            "M4.5 3.75a.75.75 0 0 0 0 1.5h11.19l-2.97 2.97a.75.75 0 1 0 1.06 1.06l4.25-4.25a.75.75 0 0 0 0-1.06l-4.25-4.25a.75.75 0 1 0-1.06 1.06l2.97 2.97H4.5Zm15 16.5a.75.75 0 0 0 0-1.5H8.31l2.97-2.97a.75.75 0 0 0-1.06-1.06l-4.25 4.25a.75.75 0 0 0 0 1.06l4.25 4.25a.75.75 0 1 0 1.06-1.06l-2.97-2.97H19.5Z",
            tweet.legacy?.retweet_count,
            "Reposts",
            "repost",
            tweetId,
            tweetUrl
          )}
          ${renderAction(
            "M16.697 5.5c-1.222 0-2.3.633-2.997 1.599-.697-.966-1.775-1.599-2.997-1.599-2.257 0-4.086 1.911-4.086 4.27 0 2.145 1.284 3.837 3.234 5.457 1.392 1.156 2.945 2.223 3.51 2.601.565-.378 2.118-1.445 3.51-2.6 1.95-1.621 3.234-3.313 3.234-5.458 0-2.359-1.829-4.27-4.086-4.27Z",
            tweet.legacy?.favorite_count,
            "Likes",
            "like",
            tweetId,
            tweetUrl
          )}
          ${renderAction(
            "M3.75 12c0-1.104.896-2 2-2s2 .896 2 2-.896 2-2 2-2-.896-2-2Zm7-5.5c0-1.104.896-2 2-2s2 .896 2 2-.896 2-2 2-2-.896-2-2Zm0 11c0-1.104.896-2 2-2s2 .896 2 2-.896 2-2 2-2-.896-2-2Zm7-8.5c0-1.104.896-2 2-2s2 .896 2 2-.896 2-2 2-2-.896-2-2Zm0 6c0-1.104.896-2 2-2s2 .896 2 2-.896 2-2 2-2-.896-2-2Z",
            tweet.views?.count,
            "Views",
            "views",
            tweetId,
            tweetUrl
          )}
          ${renderAction(
            "M6 3.75A2.25 2.25 0 0 0 3.75 6v14.19a.75.75 0 0 0 1.221.585L12 15.25l7.029 5.525a.75.75 0 0 0 1.221-.585V6A2.25 2.25 0 0 0 18 3.75H6Z",
            null,
            "Bookmark",
            "bookmark",
            tweetId,
            tweetUrl
          )}
          ${renderAction(
            "M12.75 3.75a.75.75 0 0 0-1.5 0v11.69l-3.72-3.72a.75.75 0 0 0-1.06 1.06l5 5a.75.75 0 0 0 1.06 0l5-5a.75.75 0 1 0-1.06-1.06l-3.72 3.72V3.75Z M3.75 19a.75.75 0 0 0 0 1.5h16.5a.75.75 0 0 0 0-1.5H3.75Z",
            null,
            "Share",
            "share",
            tweetId,
            tweetUrl
          )}
        </div>
        ${renderFeedbackButtons(feedbackActions)}
      </article>
    `;
  }

  function extractTimelineEntries(payload) {
    const instructions =
      payload?.data?.home?.home_timeline_urt?.instructions ||
      payload?.home?.home_timeline_urt?.instructions ||
      [];
    return instructions.flatMap((instruction) => instruction.entries || []);
  }

  function extractFeedbackMap(payload) {
    const actions =
      payload?.responseObjects?.feedbackActions ||
      payload?.data?.home?.home_timeline_urt?.responseObjects?.feedbackActions ||
      [];
    const map = new Map();

    for (const action of actions) {
      if (!action?.key || !action?.value) continue;
      map.set(String(action.key), action.value);
    }

    return map;
  }

  function unwrapTweetResult(result) {
    if (!result) return null;
    if (result.__typename === "TweetWithVisibilityResults") return result.tweet || null;
    return result;
  }

  function isRenderableTweet(result) {
    if (!result) return false;
    if (result.__typename === "Tweet") return true;
    // TweetWithVisibilityResults.tweet payloads often omit __typename.
    return Boolean(result?.legacy && (result?.rest_id || result?.legacy?.id_str));
  }

  function buildCards(payload) {
    const entries = extractTimelineEntries(payload);
    const feedbackMap = extractFeedbackMap(payload);
    const cards = [];

    for (const entry of entries) {
      const rawResult = entry?.content?.itemContent?.tweet_results?.result;
      const result = unwrapTweetResult(rawResult);
      if (!result) continue;

      if (result.__typename === "TweetTombstone") {
        if (!SHOW_TOMBSTONES) continue;
        const tombstoneText = result.tombstone?.text?.text;
        cards.push({
          html: renderTombstoneCard(tombstoneText, entry?.entryId),
          hasMedia: false,
          tweetId: null
        });
        continue;
      }

      if (!isRenderableTweet(result)) continue;
      const feedbackKeys = entry?.content?.feedbackInfo?.feedbackKeys || [];
      const feedbackActions = feedbackKeys
        .map((key) => feedbackMap.get(String(key)))
        .filter(Boolean);
      const hasMedia = Boolean(result?.legacy?.extended_entities?.media?.length);
      if (!hasMedia) continue;
      cards.push({
        html: renderTweetCard(result, entry?.entryId, feedbackActions),
        hasMedia,
        tweetId: result?.rest_id ? String(result.rest_id) : null
      });
    }

    return cards;
  }

  function createBatchId(payload, cards) {
    const entries = extractTimelineEntries(payload);
    const first = entries[0]?.entryId || "";
    const last = entries[entries.length - 1]?.entryId || "";
    return `${first}|${last}|${cards.length}`;
  }

  function findTargetCells() {
    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
    if (!primaryColumn) return [];

    const allCells = Array.from(primaryColumn.querySelectorAll('div[data-testid="cellInnerDiv"]'));
    return allCells.filter((cell) => {
      if (cell.querySelector(".x-replacement-root")) return true;
      if (cell.querySelector('article[role="article"][tabindex="-1"]')) return true;
      if (cell.querySelector('article[role="article"][aria-labelledby]')) return true;
      if (cell.querySelector('article[role="article"]')) return true;
      return false;
    });
  }

  function findNativeTweetCells() {
    return findTargetCells().filter((cell) => cell.querySelector('article[role="article"]'));
  }

  function applyCardToCell(cell, cardHtml) {
    if (cell.__xCustomCardHtml === cardHtml) return;
    cell.__xCustomCardHtml = cardHtml;
    cell.dataset.xCustomSlot = "1";
    cell.innerHTML = `<div class="x-replacement-root">${cardHtml}</div>`;
  }

  function renderCardsIntoPage() {
    if (!isExtensionEnabled) return;

    const nativeCells = findNativeTweetCells();
    let cellCursor = 0;
    while (pendingBatches.length && cellCursor < nativeCells.length) {
      const batch = pendingBatches[0];
      const cards = isGridMode ? batch.cards.filter((card) => card.hasMedia) : batch.cards;

      while (batch.cursor < cards.length && cellCursor < nativeCells.length) {
        applyCardToCell(nativeCells[cellCursor], cards[batch.cursor].html);
        cellCursor += 1;
        batch.cursor += 1;
      }

      if (batch.cursor >= cards.length) {
        pendingBatches.shift();
      } else {
        break;
      }
    }

    const allCells = findTargetCells();
    for (const cell of allCells) {
      const replaced = Boolean(cell.querySelector(".x-replacement-root"));
      cell.classList.toggle("x-grid-cell", isGridMode && replaced);
    }

    const parent = allCells[0]?.parentElement;
    if (parent) {
      parent.classList.toggle("x-grid-parent", isGridMode);
    }
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderCardsIntoPage();
    }, 80);
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .x-replacement-root {
        color: #e7e9ea;
        font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      }

      .x-replacement-root * {
        box-sizing: border-box;
      }

      .x-replacement-root a,
      .x-replacement-root button,
      .x-replacement-root .x-action {
        cursor: pointer !important;
      }

      .x-replacement-root .x-card {
        background: #000;
        border-bottom: 1px solid #2f3336;
        padding: 12px 16px 10px;
        display: grid;
        gap: 10px;
      }

      .x-replacement-root .x-header {
        display: grid;
        grid-template-columns: 42px 1fr auto;
        gap: 8px;
        align-items: start;
        position: relative;
      }

      .x-replacement-root .x-avatar-wrap {
        position: relative;
      }

      .x-replacement-root .x-avatar {
        width: 40px;
        height: 40px;
        border-radius: 999px;
        object-fit: cover;
        background: #202327;
      }

      .x-replacement-root .x-meta {
        min-width: 0;
        position: relative;
      }

      .x-replacement-root .x-meta-line {
        display: flex;
        gap: 6px;
        align-items: baseline;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .x-replacement-root .x-name {
        font-size: 16px;
        font-weight: 700;
      }

      .x-replacement-root .x-handle,
      .x-replacement-root .x-dot,
      .x-replacement-root .x-time,
      .x-replacement-root .x-menu {
        color: #71767b;
        font-size: 15px;
        line-height: 1;
      }

      .x-replacement-root .x-menu {
        font-size: 18px;
        padding: 0 2px;
      }

      .x-replacement-root .x-hover-card {
        position: absolute;
        top: calc(100% + 8px);
        left: 0;
        width: min(320px, 92vw);
        padding: 12px;
        border: 1px solid #2f3336;
        border-radius: 14px;
        background: rgba(0, 0, 0, 0.96);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
        opacity: 0;
        transform: translateY(-4px);
        pointer-events: none;
        transition: opacity 140ms ease, transform 140ms ease;
        z-index: 4;
      }

      .x-replacement-root .x-header:hover .x-hover-card {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }

      .x-replacement-root .x-hover-name {
        font-size: 15px;
        font-weight: 700;
      }

      .x-replacement-root .x-hover-handle {
        font-size: 13px;
        color: #71767b;
      }

      .x-replacement-root .x-profile-link {
        color: #e7e9ea;
        text-decoration: none;
      }

      .x-replacement-root .x-profile-link:hover {
        text-decoration: underline;
      }

      .x-replacement-root .x-handle-link {
        color: #71767b;
      }

      .x-replacement-root .x-follow-btn {
        margin-top: 8px;
        appearance: none;
        border: 1px solid #eff3f4;
        background: #eff3f4;
        color: #0f1419;
        border-radius: 999px;
        font-size: 13px;
        font-weight: 700;
        padding: 6px 14px;
      }

      .x-replacement-root .x-follow-btn:hover {
        background: #dfe3e4;
        border-color: #dfe3e4;
      }

      .x-replacement-root .x-follow-btn.is-loading {
        opacity: 0.75;
      }

      .x-replacement-root .x-follow-btn.is-success,
      .x-replacement-root .x-follow-btn.is-following {
        background: transparent;
        border-color: #2f3336;
        color: #e7e9ea;
      }

      .x-replacement-root .x-follow-btn.is-error {
        border-color: #f4212e;
      }

      .x-replacement-root .x-hover-bio {
        margin: 8px 0;
        font-size: 14px;
        line-height: 1.35;
      }

      .x-replacement-root .x-hover-stats {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        font-size: 13px;
        color: #71767b;
      }

      .x-replacement-root .x-hover-stats strong {
        color: #e7e9ea;
      }

      .x-replacement-root .x-content {
        margin: 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        line-height: 1.35;
        font-size: 15px;
        padding-left: 50px;
      }

      .x-replacement-root .x-media-grid {
        display: grid;
        gap: 6px;
        padding-left: 50px;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }

      .x-replacement-root .x-media-shell {
        position: relative;
        border: 1px solid #2f3336;
        border-radius: 16px;
        overflow: hidden;
        background: #0b0d0f;
      }

      .x-replacement-root .x-media-item {
        width: 100%;
        display: block;
        max-height: 560px;
        object-fit: cover;
        background: #000;
      }

      .x-replacement-root .x-video-play {
        position: absolute;
        inset: 0;
        margin: auto;
        width: 58px;
        height: 58px;
        border-radius: 999px;
        background: rgba(15, 20, 25, 0.65);
        display: grid;
        place-items: center;
        pointer-events: none;
      }

      .x-replacement-root .x-media-shell.x-video-playing .x-video-play {
        opacity: 0;
        transform: scale(0.85);
        transition: opacity 140ms ease, transform 140ms ease;
      }

      .x-replacement-root .x-video-play::before {
        content: "";
        width: 0;
        height: 0;
        border-top: 10px solid transparent;
        border-bottom: 10px solid transparent;
        border-left: 16px solid #fff;
        transform: translateX(2px);
      }

      .x-replacement-root .x-actions {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px;
        color: #71767b;
        font-size: 14px;
        padding-top: 4px;
        padding-left: 50px;
      }

      .x-replacement-root .x-action {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 64px;
        transition: color 120ms ease, opacity 120ms ease;
      }

      .x-replacement-root .x-action:hover {
        color: #1d9bf0;
      }

      .x-replacement-root .x-action.is-loading {
        opacity: 0.65;
      }

      .x-replacement-root .x-action.is-success {
        color: #00ba7c;
      }

      .x-replacement-root .x-action.is-error {
        color: #f4212e;
      }

      .x-replacement-root .x-media-credit {
        padding-left: 50px;
        color: #71767b;
        font-size: 14px;
      }

      .x-replacement-root .x-media-credit span {
        color: #e7e9ea;
        font-weight: 600;
      }

      .x-replacement-root .x-source-link {
        color: #e7e9ea;
        font-weight: 600;
        text-decoration: none;
      }

      .x-replacement-root .x-source-link:hover {
        text-decoration: underline;
      }

      .x-replacement-root .x-feedback-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        padding-left: 50px;
      }

      .x-replacement-root .x-feedback-btn {
        appearance: none;
        border: 1px solid #2f3336;
        color: #e7e9ea;
        background: #111;
        border-radius: 999px;
        padding: 6px 10px;
        font-size: 12px;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease;
      }

      .x-replacement-root .x-feedback-btn:hover {
        background: #1d1f22;
        border-color: #536471;
      }

      .x-replacement-root .x-feedback-btn:disabled {
        opacity: 0.65;
        cursor: default;
      }

      .x-replacement-root .x-icon {
        width: 18px;
        height: 18px;
        stroke: currentColor;
        fill: none;
        stroke-width: 1.8;
      }

      .x-replacement-root .x-tombstone {
        border: 1px solid #6f5d2e;
        border-radius: 14px;
      }

      .x-replacement-root .x-badge {
        display: inline-block;
        margin-bottom: 6px;
        font-size: 12px;
        color: #111;
        background: #f0b90b;
        border-radius: 999px;
        padding: 2px 8px;
        font-weight: 700;
        width: fit-content;
      }

      .x-grid-parent {
        display: grid !important;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: 12px;
        padding: 10px;
      }

      .x-grid-parent > .x-grid-cell {
        min-width: 0;
      }

      .x-grid-parent > .x-grid-cell .x-replacement-root .x-card {
        border: 1px solid #2f3336;
        border-radius: 12px;
        padding: 0 0 10px;
        overflow: hidden;
        gap: 6px;
      }

      .x-grid-parent > .x-grid-cell .x-replacement-root .x-media-grid {
        order: 1;
        padding-left: 0;
        grid-template-columns: 1fr;
        gap: 0;
      }

      .x-grid-parent > .x-grid-cell .x-replacement-root .x-media-shell {
        border: 0;
        border-radius: 0;
      }

      .x-grid-parent > .x-grid-cell .x-replacement-root .x-media-item {
        max-height: none;
        aspect-ratio: 16 / 9;
      }

      .x-grid-parent > .x-grid-cell .x-replacement-root .x-header {
        order: 2;
        grid-template-columns: 40px 1fr;
        padding: 8px 10px 0;
      }

      .x-grid-parent > .x-grid-cell .x-replacement-root .x-menu {
        display: none;
      }

      .x-grid-parent > .x-grid-cell .x-replacement-root .x-content {
        order: 3;
        padding: 0 10px;
        font-size: 14px;
        line-height: 1.35;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      .x-grid-parent > .x-grid-cell .x-replacement-root .x-media-credit {
        order: 4;
        padding: 0 10px;
        font-size: 12px;
      }

      .x-grid-parent > .x-grid-cell .x-replacement-root .x-actions {
        order: 5;
        padding: 0 10px;
      }

      .x-grid-parent > .x-grid-cell .x-replacement-root .x-action:nth-child(n + 5) {
        display: none;
      }

      .x-grid-parent > .x-grid-cell .x-replacement-root .x-feedback-row,
      .x-grid-parent > .x-grid-cell .x-replacement-root .x-hover-card {
        display: none;
      }

      @media (max-width: 640px) {
        .x-grid-parent {
          grid-template-columns: 1fr;
          padding: 0;
          gap: 0;
        }

        .x-replacement-root .x-content,
        .x-replacement-root .x-media-grid,
        .x-replacement-root .x-actions,
        .x-replacement-root .x-feedback-row,
        .x-replacement-root .x-media-credit {
          padding-left: 0;
        }
      }
    `;

    document.documentElement.appendChild(style);
  }

  function maybeUsePayload(payload) {
    if (!isExtensionEnabled) return;

    const cards = buildCards(payload);
    if (!cards.length) return;

    const freshCards = cards.filter((card) => {
      if (!card.tweetId) return true;
      if (seenTweetIds.has(card.tweetId)) return false;
      seenTweetIds.add(card.tweetId);
      return true;
    });
    if (!freshCards.length) return;

    latestCards = freshCards;
    const batchId = createBatchId(payload, freshCards);
    if (seenBatchIds.has(batchId)) return;
    seenBatchIds.add(batchId);
    pendingBatches.push({ batchId, cards: freshCards, cursor: 0 });
    scheduleRender();
  }

  function initializeSettings(onInitialSettingsReady) {
    chrome.storage.sync.get({ [EXTENSION_ENABLED_KEY]: true }, (items) => {
      isExtensionEnabled = Boolean(items[EXTENSION_ENABLED_KEY]);
      // Grid mode toggle is removed from UI for now; keep timeline in list mode.
      isGridMode = false;
      if (typeof onInitialSettingsReady === "function") {
        onInitialSettingsReady();
      }
      if (isExtensionEnabled) {
        scheduleRender();
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") return;

      if (changes[EXTENSION_ENABLED_KEY]) {
        const nextEnabled = Boolean(changes[EXTENSION_ENABLED_KEY].newValue);
        if (nextEnabled !== isExtensionEnabled) {
          isExtensionEnabled = nextEnabled;
          window.location.reload();
        }
        return;
      }
    });
  }

  function injectHook() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-hook.js");
    script.async = false;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  function bindMessageBridge() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const message = event.data;
      if (!message || message.source !== BRIDGE_SOURCE) return;

      if (message.kind === "timeline-payload") {
        maybeUsePayload(message.payload);
        return;
      }

      if (message.kind === "feedback-result" && message.requestId) {
        const resolver = feedbackResolvers.get(message.requestId);
        if (resolver) resolver(message);
        return;
      }

      if (message.kind === "action-result" && message.requestId) {
        const resolver = actionResolvers.get(message.requestId);
        if (resolver) resolver(message);
      }
    });
  }

  function bindFeedbackClicks() {
    document.addEventListener("click", async (event) => {
      if (!isExtensionEnabled) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest(".x-feedback-btn");
      if (!(button instanceof HTMLButtonElement)) return;

      event.preventDefault();
      event.stopPropagation();

      const feedbackUrl = button.dataset.feedbackUrl || "";
      if (!feedbackUrl) return;

      const url = normalizeFeedbackUrl(feedbackUrl);
      if (!url) return;

      const originalText = button.textContent || "Feedback";
      button.disabled = true;
      button.textContent = "Sending...";

      try {
        const bridgeResult = await requestFeedbackViaPage(url);
        if (!bridgeResult?.ok) {
          const csrfToken = readCookie("ct0");
          let response = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: {
              "x-requested-with": "XMLHttpRequest",
              "x-csrf-token": csrfToken,
              "x-twitter-active-user": "yes",
              "x-twitter-auth-type": "OAuth2Session"
            }
          });

          if (!response.ok) {
            response = await fetch(url, {
              method: "GET",
              credentials: "include",
              headers: {
                "x-requested-with": "XMLHttpRequest",
                "x-csrf-token": csrfToken,
                "x-twitter-active-user": "yes",
                "x-twitter-auth-type": "OAuth2Session"
              }
            });
          }

          if (!response.ok) {
            throw new Error(`Feedback request failed (${response.status})`);
          }
        }

        button.textContent = "Submitted";
      } catch (error) {
        button.textContent = "Failed";
        button.title = error?.message || "Feedback request failed";
        setTimeout(() => {
          button.disabled = false;
          button.textContent = originalText;
          button.title = "";
        }, 3000);
        return;
      }
    });
  }

  async function handleAction(action, tweetId, tweetUrl, userId, screenName) {
    if (!action) return { ok: false, error: "Missing action" };

    switch (action) {
      case "reply":
        if (tweetUrl) {
          window.location.assign(tweetUrl);
          return { ok: true, navigated: true };
        }
        return { ok: false, error: "Missing tweet url" };
      case "repost":
      case "like":
      case "bookmark":
        if (!tweetId) return { ok: false, error: "Missing tweet id" };
        return requestActionViaPage(action, tweetId, tweetUrl);
      case "follow":
        if (!userId) return { ok: false, error: "Missing user id" };
        return requestActionViaPage(action, tweetId, tweetUrl, { userId, screenName });
      case "share":
        if (navigator.share && tweetUrl) {
          try {
            await navigator.share({ url: tweetUrl });
            return { ok: true };
          } catch {
            // fallback to clipboard
          }
        }
        if (tweetUrl) {
          try {
            await navigator.clipboard.writeText(tweetUrl);
            return { ok: true };
          } catch {
            return { ok: false, error: "Share failed" };
          }
        }
        return { ok: false, error: "Missing tweet url" };
      case "views":
        if (tweetUrl) {
          window.location.assign(tweetUrl);
          return { ok: true, navigated: true };
        }
        return { ok: false, error: "Missing tweet url" };
      default:
        if (tweetUrl) {
          window.location.assign(tweetUrl);
          return { ok: true, navigated: true };
        }
        return { ok: false, error: "Unsupported action" };
    }
  }

  function bindActionClicks() {
    const trigger = async (actionEl) => {
      if (!isExtensionEnabled) return;
      if (actionEl.dataset.busy === "1") return;
      const action = actionEl.dataset.action || "";
      const tweetId = actionEl.dataset.tweetId || "";
      const tweetUrl = actionEl.dataset.tweetUrl || "";
      const userId = actionEl.dataset.userId || "";
      const screenName = actionEl.dataset.screenName || "";
      if (action === "follow" && actionEl.dataset.following === "1") return;
      const originalTitle = actionEl.getAttribute("title") || "";
      const originalText = actionEl.textContent || "";

      actionEl.dataset.busy = "1";
      actionEl.classList.remove("is-success", "is-error");
      actionEl.classList.add("is-loading");
      if (action === "like") {
        actionEl.setAttribute("title", "Liking...");
      } else if (action === "repost") {
        actionEl.setAttribute("title", "Reposting...");
      } else if (action === "bookmark") {
        actionEl.setAttribute("title", "Bookmarking...");
      } else if (action === "follow") {
        actionEl.setAttribute("title", "Following...");
      }

      try {
        const result = await handleAction(action, tweetId, tweetUrl, userId, screenName);
        if (!result?.ok) {
          const statusText =
            typeof result?.status === "number" && result.status > 0 ? ` (${result.status})` : "";
          throw new Error(`${result?.error || "Action failed"}${statusText}`);
        }
        actionEl.classList.add("is-success");
        if (action === "follow") {
          actionEl.dataset.following = "1";
          actionEl.classList.add("is-following");
          actionEl.textContent = "Following";
          actionEl.setAttribute("title", "Following");
        }
      } catch (error) {
        actionEl.classList.add("is-error");
        actionEl.setAttribute("title", error?.message || "Action failed");
        if (action === "follow") {
          actionEl.textContent = originalText || "Follow";
        }
      } finally {
        actionEl.classList.remove("is-loading");
        actionEl.dataset.busy = "0";
        setTimeout(() => {
          if (actionEl.dataset.busy === "1") return;
          if (action !== "follow" || actionEl.dataset.following !== "1") {
            actionEl.classList.remove("is-success", "is-error");
            if (originalTitle) {
              actionEl.setAttribute("title", originalTitle);
            } else {
              actionEl.removeAttribute("title");
            }
          } else {
            actionEl.classList.remove("is-error");
            actionEl.setAttribute("title", "Following");
          }
        }, 1400);
      }
    };

    document.addEventListener("click", async (event) => {
      if (!isExtensionEnabled) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const actionEl = target.closest(".x-action, .x-follow-btn");
      if (!(actionEl instanceof HTMLElement)) return;
      event.preventDefault();
      event.stopPropagation();
      await trigger(actionEl);
    });

    document.addEventListener("keydown", async (event) => {
      if (!isExtensionEnabled) return;

      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const actionEl = target.closest(".x-action, .x-follow-btn");
      if (!(actionEl instanceof HTMLElement)) return;
      event.preventDefault();
      await trigger(actionEl);
    });
  }

  function bindVideoOverlayState() {
    const updateState = (videoEl, isPlaying) => {
      const mediaShell = videoEl.closest(".x-media-shell");
      if (!mediaShell) return;
      mediaShell.classList.toggle("x-video-playing", isPlaying);
    };

    document.addEventListener(
      "play",
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLVideoElement)) return;
        if (!target.classList.contains("x-media-item")) return;
        updateState(target, true);
      },
      true
    );

    document.addEventListener(
      "pause",
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLVideoElement)) return;
        if (!target.classList.contains("x-media-item")) return;
        updateState(target, false);
      },
      true
    );

    document.addEventListener(
      "ended",
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLVideoElement)) return;
        if (!target.classList.contains("x-media-item")) return;
        updateState(target, false);
      },
      true
    );
  }

  function startLayoutObserver() {
    const observer = new MutationObserver(() => {
      if (!latestCards.length) return;
      scheduleRender();
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function init() {
    installStyles();
    bindMessageBridge();
    bindFeedbackClicks();
    bindActionClicks();
    bindVideoOverlayState();
    initializeSettings(() => {
      if (!isExtensionEnabled) return;
      injectHook();
      startLayoutObserver();
    });
  }

  init();
})();



