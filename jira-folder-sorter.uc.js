// ==UserScript==
// @name        Jira Folder Sorter
// @description Files newly opened Jira issue tabs into a Zen tab folder.
//              group-by = "project": one folder per project key (default,
//              no API calls). "epic" / "story": one folder per epic or per
//              story, resolved by walking the issue's real Jira parent
//              chain via the REST API (needs an API token).
// @version     0.2.0
// ==/UserScript==

(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") {
    return;
  }

  const PREF_ENABLED = "extensions.jira-folder-sorter.enabled";
  const PREF_BASE_URL = "extensions.jira-folder-sorter.jira-base-url";
  const PREF_GROUP_BY = "extensions.jira-folder-sorter.group-by"; // "project" | "epic" | "story"
  const PREF_COLOR = "extensions.jira-folder-sorter.group-color";
  const PREF_EMAIL = "extensions.jira-folder-sorter.jira-email";
  const PREF_TOKEN = "extensions.jira-folder-sorter.jira-api-token";

  const LOG_PREFIX = "[Jira Folder Sorter]";

  // Where each level sits in the hierarchy. Lower = closer to the top.
  // Anything not matching epic/story is treated as a leaf (task, subtask,
  // bug, etc).
  const RANK = { epic: 0, story: 1, other: 2 };
  function rankOf(issuetypeName) {
    const t = (issuetypeName || "").toLowerCase();
    if (t.includes("epic")) return RANK.epic;
    if (t.includes("story")) return RANK.story;
    return RANK.other;
  }

  // issueKey -> { key, rank, summary, parentKey } | null (null = lookup failed, don't retry)
  const issueNodeCache = new Map();

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }
  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function getBoolPref(name, fallback) {
    try {
      return Services.prefs.getBoolPref(name, fallback);
    } catch (e) {
      return fallback;
    }
  }
  function getStringPref(name, fallback) {
    try {
      const val = Services.prefs.getStringPref(name, fallback);
      return val == null ? fallback : val;
    } catch (e) {
      return fallback;
    }
  }

  /** "https://co.atlassian.net/browse/PROJ-123" -> { issueKey, projectKey } */
  function parseJiraUrl(urlStr, baseUrlStr) {
    if (!urlStr || !baseUrlStr) return null;
    let url, base;
    try {
      url = new URL(urlStr);
      base = new URL(baseUrlStr);
    } catch (e) {
      return null;
    }
    if (url.hostname !== base.hostname) return null;

    let m = url.pathname.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/);
    if (!m) m = url.search.match(/[?&]selectedIssue=([A-Z][A-Z0-9_]*-\d+)/);
    if (!m) return null;

    const issueKey = m[1];
    return { issueKey, projectKey: issueKey.split("-")[0] };
  }

  function truncateLabel(label) {
    if (label && label.length > 40) return label.slice(0, 37) + "...";
    return label;
  }

  /** Fetches (and caches) one issue's type/summary/parent from the Jira API. */
  async function getIssueNode(baseUrl, issueKey, email, token) {
    if (issueNodeCache.has(issueKey)) return issueNodeCache.get(issueKey);
    try {
      const auth = "Basic " + btoa(`${email}:${token}`);
      const endpoint =
        `${baseUrl.replace(/\/$/, "")}/rest/api/3/issue/${issueKey}` +
        `?fields=summary,parent,issuetype`;
      const resp = await fetch(endpoint, {
        headers: { Authorization: auth, Accept: "application/json" },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const fields = data.fields || {};
      const node = {
        key: issueKey,
        rank: rankOf(fields.issuetype && fields.issuetype.name),
        summary: fields.summary || "",
        parentKey: fields.parent ? fields.parent.key : null,
      };
      issueNodeCache.set(issueKey, node);
      return node;
    } catch (e) {
      warn(`Issue lookup failed for ${issueKey}:`, e.message);
      issueNodeCache.set(issueKey, null);
      return null;
    }
  }

  /**
   * Walks up from `startKey` through its parent chain looking for an
   * ancestor (or the issue itself) at `targetRank` (epic=0, story=1). If
   * none exists in the chain (e.g. asking for the story-ancestor of an
   * epic), falls back to the nearest *higher-level* ancestor found instead
   * (e.g. the epic itself). Returns null if nothing useful was found, in
   * which case the caller should fall back to project-key grouping.
   */
  async function resolveAncestor(baseUrl, startKey, targetRank, email, token) {
    const MAX_DEPTH = 6;
    const chain = [];
    let curKey = startKey;
    let depth = 0;

    while (curKey && depth <= MAX_DEPTH) {
      const node = await getIssueNode(baseUrl, curKey, email, token);
      if (!node) break;
      chain.push(node);
      if (node.rank === targetRank) return node; // exact match, stop early
      curKey = node.parentKey;
      depth++;
    }

    const higher = chain
      .filter((n) => n.rank < targetRank)
      .sort((a, b) => a.rank - b.rank)[0];
    return higher || null;
  }

  async function resolveLabel(mode, baseUrl, issueKey, projectKey, email, token) {
    if (mode === "epic" || mode === "story") {
      if (!email || !token) return projectKey; // not configured, fall back silently
      const targetRank = mode === "epic" ? RANK.epic : RANK.story;
      const anchor = await resolveAncestor(baseUrl, issueKey, targetRank, email, token);
      if (anchor) return truncateLabel(`${anchor.key} ${anchor.summary}`.trim());
      return projectKey;
    }
    return projectKey; // mode === "project"
  }

  function findGroupByLabel(label) {
    for (const group of gBrowser.tabGroups) {
      if (group.label === label) return group;
    }
    return null;
  }

  /**
   * Moves `tab` into the folder named `label`, creating it if needed. The
   * exact internal method for "move a tab into an existing group" has
   * shifted across Firefox/Zen releases, so this tries a few known shapes
   * and logs clearly if none work - see README troubleshooting.
   */
  function placeTabInGroup(tab, label, color) {
    if (!label || !tab || tab.closing) return;
    if (tab.group && tab.group.label === label) return;

    let group = findGroupByLabel(label);

    if (!group) {
      try {
        gBrowser.addTabGroup([tab], { label, color: color || "blue", insertBefore: null });
        log(`Created folder "${label}"`);
      } catch (e) {
        warn(`Failed to create folder "${label}":`, e);
      }
      return;
    }

    try {
      if (typeof gBrowser.moveTabToGroup === "function") {
        gBrowser.moveTabToGroup(tab, group);
      } else if (typeof gBrowser.moveTabsToGroup === "function") {
        gBrowser.moveTabsToGroup([tab], group);
      } else if (typeof group.addTabs === "function") {
        group.addTabs([tab]);
      } else {
        throw new Error("no known move-into-group method found on gBrowser/tabGroup");
      }
      log(`Filed tab into existing folder "${label}"`);
    } catch (e) {
      warn(`Failed to move tab into folder "${label}":`, e);
    }
  }

  async function handleTab(tab) {
    if (!getBoolPref(PREF_ENABLED, true)) return;
    if (!tab || tab.closing) return;

    const browser = tab.linkedBrowser;
    if (!browser || !browser.currentURI) return;
    const url = browser.currentURI.spec;
    if (!url || url === "about:blank") return;

    const baseUrl = getStringPref(PREF_BASE_URL, "");
    if (!baseUrl) return;

    const parsed = parseJiraUrl(url, baseUrl);
    if (!parsed) return;

    if (tab.group) return; // already filed somewhere, leave it alone

    const mode = getStringPref(PREF_GROUP_BY, "project");
    const color = getStringPref(PREF_COLOR, "blue");
    const email = getStringPref(PREF_EMAIL, "");
    const token = getStringPref(PREF_TOKEN, "");

    const label = await resolveLabel(
      mode,
      baseUrl,
      parsed.issueKey,
      parsed.projectKey,
      email,
      token
    );
    placeTabInGroup(tab, label, color);
  }

  function onTabOpen(event) {
    const tab = event.target;
    const browser = tab.linkedBrowser;
    if (!browser) return;

    const listener = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
      onLocationChange(webProgress) {
        if (!webProgress.isTopLevel) return;
        handleTab(tab);
      },
    };

    try {
      browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_LOCATION);
    } catch (e) {
      warn("Could not attach progress listener:", e);
      return;
    }

    tab.addEventListener(
      "TabClose",
      () => {
        try {
          browser.removeProgressListener(listener);
        } catch (e) {
          /* already torn down */
        }
      },
      { once: true }
    );

    if (browser.currentURI && browser.currentURI.spec !== "about:blank") {
      handleTab(tab);
    }
  }

  function init() {
    gBrowser.tabContainer.addEventListener("TabOpen", onTabOpen);
    log("initialized");
  }

  if (typeof gBrowserInit !== "undefined" && gBrowserInit.delayedStartupFinished) {
    init();
  } else {
    const observer = (subject, topic) => {
      if (subject === window) {
        Services.obs.removeObserver(observer, topic);
        init();
      }
    };
    Services.obs.addObserver(observer, "browser-delayed-startup-finished");
  }
})();
