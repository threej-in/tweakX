(() => {
  const BRIDGE_SOURCE = "x-home-timeline-hook";
  const CONTENT_SOURCE = "x-home-timeline-content";
  const cachedApiHeaders = {};
  const graphqlOperations = new Map();
  const graphqlPayloadHints = new Map();
  let globalGraphqlFeatures = null;
  const defaultGraphqlIds = {
    FavoriteTweet: "lI07N6Otwv1PhnEgXILM7A",
    CreateBookmark: "aoDbu3RHznuiSkQ9aNM67Q"
  };
  const STABLE_HEADER_KEYS = new Set([
    "authorization",
    "x-guest-token",
    "x-csrf-token",
    "x-twitter-active-user",
    "x-twitter-auth-type",
    "x-twitter-client-language",
    "x-twitter-client-deviceid",
    "x-client-uuid"
  ]);

  function postTimelinePayload(url, payload) {
    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        kind: "timeline-payload",
        url,
        payload
      },
      "*"
    );
  }

  function tryParseJson(text) {
    if (!text || typeof text !== "string") return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function isHomeTimelineUrl(url) {
    if (!url || typeof url !== "string") return false;
    return /HomeTimeline|home_timeline_urt|hometimeline/i.test(url);
  }

  function isApiUrl(url) {
    if (!url || typeof url !== "string") return false;
    return /\/i\/api\/|\/graphql\//i.test(url);
  }

  function rememberGraphqlOperation(url) {
    if (!url || typeof url !== "string") return;
    const match = url.match(/\/i\/api\/graphql\/([^/?]+)\/([^/?]+)/i);
    if (!match) return;

    const queryId = decodeURIComponent(match[1] || "").trim();
    const operationName = decodeURIComponent(match[2] || "").trim();
    if (!queryId || !operationName) return;
    graphqlOperations.set(operationName, queryId);
  }

  function rememberGraphqlPayloadHint(url, init) {
    if (!url || typeof url !== "string") return;
    if (!/\/i\/api\/graphql\//i.test(url)) return;

    const match = url.match(/\/i\/api\/graphql\/([^/?]+)\/([^/?]+)/i);
    if (!match) return;
    const operationName = decodeURIComponent(match[2] || "").trim();
    if (!operationName) return;

    const bodyText = init?.body;
    if (typeof bodyText !== "string" || !bodyText.trim()) return;

    const body = tryParseJson(bodyText);
    if (!body || typeof body !== "object") return;

    if (body.features && typeof body.features === "object") {
      globalGraphqlFeatures = body.features;
    }

    const hint = {};
    if (body.features && typeof body.features === "object") {
      hint.features = body.features;
    }
    if (body.fieldToggles && typeof body.fieldToggles === "object") {
      hint.fieldToggles = body.fieldToggles;
    }
    if (typeof body.query_source === "string" && body.query_source) {
      hint.query_source = body.query_source;
    }
    if (Object.keys(hint).length) {
      graphqlPayloadHints.set(operationName, hint);
    }
  }

  function readCookie(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : "";
  }

  function rememberHeaderSet(headers) {
    if (!headers) return;

    if (headers instanceof Headers) {
      for (const [key, value] of headers.entries()) {
        const normalized = String(key || "").toLowerCase();
        if (STABLE_HEADER_KEYS.has(normalized) && value) {
          cachedApiHeaders[normalized] = String(value);
        }
      }
      return;
    }

    if (Array.isArray(headers)) {
      for (const [key, value] of headers) {
        const normalized = String(key || "").toLowerCase();
        if (STABLE_HEADER_KEYS.has(normalized) && value) {
          cachedApiHeaders[normalized] = String(value);
        }
      }
      return;
    }

    if (typeof headers === "object") {
      for (const [key, value] of Object.entries(headers)) {
        const normalized = String(key || "").toLowerCase();
        if (STABLE_HEADER_KEYS.has(normalized) && value) {
          cachedApiHeaders[normalized] = String(value);
        }
      }
    }
  }

  function rememberAuthHeaders(input, init) {
    rememberHeaderSet(init?.headers);
    rememberHeaderSet(input?.headers);
  }

  function normalizeFeedbackUrls(url) {
    if (!url) return [];
    if (url.startsWith("http://") || url.startsWith("https://")) return [url];

    const absolute = url.startsWith("/")
      ? `${window.location.origin}${url}`
      : `${window.location.origin}/${url}`;
    const urls = [absolute];

    if (url.startsWith("/2/")) {
      urls.push(`${window.location.origin}/i/api${url}`);
    }
    if (url.startsWith("/i/api/2/")) {
      urls.push(`${window.location.origin}${url.replace("/i/api", "")}`);
    }

    return [...new Set(urls)];
  }

  async function submitFeedback(url) {
    const urls = normalizeFeedbackUrls(url);
    const csrfToken = readCookie("ct0");
    const headers = {
      "x-requested-with": "XMLHttpRequest",
      "x-csrf-token": csrfToken || cachedApiHeaders["x-csrf-token"] || "",
      "x-twitter-active-user": cachedApiHeaders["x-twitter-active-user"] || "yes",
      "x-twitter-auth-type": cachedApiHeaders["x-twitter-auth-type"] || "OAuth2Session"
    };
    if (cachedApiHeaders.authorization) {
      headers.authorization = cachedApiHeaders.authorization;
    }
    if (cachedApiHeaders["x-guest-token"]) {
      headers["x-guest-token"] = cachedApiHeaders["x-guest-token"];
    }
    if (cachedApiHeaders["x-twitter-client-language"]) {
      headers["x-twitter-client-language"] = cachedApiHeaders["x-twitter-client-language"];
    }
    if (cachedApiHeaders["x-twitter-client-deviceid"]) {
      headers["x-twitter-client-deviceid"] = cachedApiHeaders["x-twitter-client-deviceid"];
    }
    if (cachedApiHeaders["x-client-uuid"]) {
      headers["x-client-uuid"] = cachedApiHeaders["x-client-uuid"];
    }

    for (const candidate of urls) {
      for (const method of ["POST", "GET"]) {
        try {
          const response = await fetch(candidate, {
            method,
            credentials: "include",
            headers
          });
          if (response.ok) {
            return { ok: true, status: response.status, url: candidate, method };
          }
        } catch {
          // try next candidate
        }
      }
    }

    return { ok: false, status: 0 };
  }

  function buildApiHeaders(extraHeaders = {}) {
    const csrfToken = readCookie("ct0");
    const headers = {
      "x-requested-with": "XMLHttpRequest",
      "x-csrf-token": csrfToken || cachedApiHeaders["x-csrf-token"] || "",
      "x-twitter-active-user": cachedApiHeaders["x-twitter-active-user"] || "yes",
      "x-twitter-auth-type": cachedApiHeaders["x-twitter-auth-type"] || "OAuth2Session",
      ...extraHeaders
    };

    if (cachedApiHeaders.authorization) {
      headers.authorization = cachedApiHeaders.authorization;
    }
    if (cachedApiHeaders["x-guest-token"]) {
      headers["x-guest-token"] = cachedApiHeaders["x-guest-token"];
    }
    if (cachedApiHeaders["x-twitter-client-language"]) {
      headers["x-twitter-client-language"] = cachedApiHeaders["x-twitter-client-language"];
    }
    if (cachedApiHeaders["x-twitter-client-deviceid"]) {
      headers["x-twitter-client-deviceid"] = cachedApiHeaders["x-twitter-client-deviceid"];
    }
    if (cachedApiHeaders["x-client-uuid"]) {
      headers["x-client-uuid"] = cachedApiHeaders["x-client-uuid"];
    }

    return headers;
  }

  async function postJson(url, payload) {
    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: buildApiHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(payload || {})
      });
      return { ok: response.ok, status: response.status, url };
    } catch {
      return { ok: false, status: 0, url };
    }
  }

  async function postForm(url, values) {
    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: buildApiHeaders({
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8"
        }),
        body: new URLSearchParams(values || {}).toString()
      });
      return { ok: response.ok, status: response.status, url };
    } catch {
      return { ok: false, status: 0, url };
    }
  }

  async function tryGraphqlAction(action, tweetId, userId) {
    const opNamesByAction = {
      like: ["FavoriteTweet", "CreateFavorite"],
      repost: ["CreateRetweet"],
      bookmark: ["CreateBookmark"],
      follow: ["CreateFriendship"]
    };
    const operationNames = opNamesByAction[action] || [];
    if (!operationNames.length) {
      return { ok: false, status: 0, error: `Unsupported action: ${action}` };
    }
    let lastFailure = null;

    for (const operationName of operationNames) {
      const queryId = graphqlOperations.get(operationName) || defaultGraphqlIds[operationName];
      if (!queryId) continue;

      const url = `${window.location.origin}/i/api/graphql/${queryId}/${operationName}`;
      const variables =
        action === "follow"
          ? {
              user_id: userId
            }
          : {
              tweet_id: tweetId
            };
      const payloadHint = graphqlPayloadHints.get(operationName) || {};
      const payload = {
        queryId,
        variables,
        ...payloadHint
      };
      if (!payload.features && globalGraphqlFeatures) {
        payload.features = globalGraphqlFeatures;
      }

      const result = await postJson(url, payload);
      if (result.ok) {
        return { ...result, method: "POST", strategy: "graphql", operationName };
      }
      lastFailure = { ...result, operationName };
    }

    const knownOps = operationNames.join(", ");
    return {
      ok: false,
      status: lastFailure?.status || 0,
      error: `GraphQL queryId missing or failed for ${action}. Expected: ${knownOps}`
    };
  }

  async function tryBookmarkFallback(tweetId) {
    const first = await postJson(`${window.location.origin}/i/api/2/bookmarks`, {
      tweet_id: tweetId
    });
    if (first.ok) {
      return { ...first, method: "POST", strategy: "bookmark-api2" };
    }

    const second = await postForm(`${window.location.origin}/i/api/1.1/bookmark/entries/add.json`, {
      tweet_id: tweetId
    });
    if (second.ok) {
      return { ...second, method: "POST", strategy: "bookmark-legacy" };
    }

    return {
      ok: false,
      status: second.status || first.status || 0,
      error: "Bookmark fallback failed"
    };
  }

  async function tryFollowFallback(userId, screenName) {
    const result = await postForm(`${window.location.origin}/i/api/1.1/friendships/create.json`, {
      user_id: userId,
      screen_name: screenName || "",
      include_blocking: "1",
      include_blocked_by: "1",
      include_followed_by: "1",
      include_want_retweets: "1",
      include_mute_edge: "1",
      include_can_dm: "1",
      include_can_media_tag: "1",
      skip_status: "1"
    });
    if (result.ok) {
      return { ...result, method: "POST", strategy: "follow-legacy" };
    }

    return {
      ok: false,
      status: result.status || 0,
      error: "Follow fallback failed"
    };
  }

  async function submitAction(action, tweetId, userId, screenName) {
    if (!action) {
      return { ok: false, status: 0, error: "Missing action" };
    }
    if (action === "follow" && !userId) {
      return { ok: false, status: 0, error: "Missing user id" };
    }
    if (action !== "follow" && !tweetId) {
      return { ok: false, status: 0, error: "Missing tweet id" };
    }
    if (!cachedApiHeaders.authorization) {
      return { ok: false, status: 0, error: "Missing authorization header from page session" };
    }
    if (!readCookie("ct0") && !cachedApiHeaders["x-csrf-token"]) {
      return { ok: false, status: 0, error: "Missing csrf token from page session" };
    }

    const gqlResult = await tryGraphqlAction(action, tweetId, userId);
    if (gqlResult.ok) return gqlResult;

    if (action === "bookmark") {
      const bookmarkFallback = await tryBookmarkFallback(tweetId);
      if (bookmarkFallback.ok) return bookmarkFallback;
      return {
        ok: false,
        status: bookmarkFallback.status || gqlResult.status || 0,
        error: bookmarkFallback.error || gqlResult.error || "Bookmark request failed"
      };
    }

    if (action === "follow") {
      const followFallback = await tryFollowFallback(userId, screenName);
      if (followFallback.ok) return followFallback;
      return {
        ok: false,
        status: followFallback.status || gqlResult.status || 0,
        error: followFallback.error || gqlResult.error || "Follow request failed"
      };
    }

    return {
      ok: false,
      status: gqlResult.status || 0,
      error: gqlResult.error || "Action request failed"
    };
  }

  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (!message || message.source !== CONTENT_SOURCE) return;

    if (message.kind === "feedback-submit") {
      const requestId = message.requestId;
      const result = await submitFeedback(message.url || "");
      window.postMessage(
        {
          source: BRIDGE_SOURCE,
          kind: "feedback-result",
          requestId,
          ...result
        },
        "*"
      );
      return;
    }

    if (message.kind === "action-submit") {
      const requestId = message.requestId;
      const result = await submitAction(
        message.action || "",
        message.tweetId || "",
        message.userId || "",
        message.screenName || ""
      );
      window.postMessage(
        {
          source: BRIDGE_SOURCE,
          kind: "action-result",
          requestId,
          action: message.action || "",
          ...result
        },
        "*"
      );
    }
  });

  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    try {
      const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (isApiUrl(requestUrl)) {
        rememberGraphqlOperation(requestUrl);
        rememberGraphqlPayloadHint(requestUrl, args[1]);
        rememberAuthHeaders(args[0], args[1]);
      }
    } catch {
      // ignore header capture errors
    }

    const response = await originalFetch(...args);

    try {
      const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url;
      const responseUrl = response?.url || requestUrl || "";
      if (isApiUrl(responseUrl)) {
        rememberGraphqlOperation(responseUrl);
      }
      if (isHomeTimelineUrl(responseUrl)) {
        const cloned = response.clone();
        cloned
          .json()
          .then((json) => postTimelinePayload(responseUrl, json))
          .catch(() => {
            // ignore parse errors
          });
      }
    } catch {
      // ignore hook errors
    }

    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__xTimelineUrl = url;
    this.__xApiRequest = isApiUrl(url);
    rememberGraphqlOperation(url);
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      const normalized = String(name || "").toLowerCase();
      if (this.__xApiRequest && STABLE_HEADER_KEYS.has(normalized) && value) {
        cachedApiHeaders[normalized] = String(value);
      }
    } catch {
      // ignore header capture errors
    }

    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const url = this.responseURL || this.__xTimelineUrl || "";
        if (!isHomeTimelineUrl(url)) return;

        const json = this.responseType === "json" ? this.response : tryParseJson(this.responseText);
        if (json) postTimelinePayload(url, json);
      } catch {
        // ignore hook errors
      }
    });

    return originalSend.apply(this, args);
  };
})();
