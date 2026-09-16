// ==UserScript==
// @name        Jira Folder Sorter
// @description Automatically organizes Jira tabs into native Zen folders.
// @version     1.2.0
// ==/UserScript==

(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") {
    return;
  }

  const PREF_ENABLED =
    "extensions.jira-folder-sorter.enabled";

  const PREF_BASE_URL =
    "extensions.jira-folder-sorter.jira-base-url";

  const LOG_PREFIX = "[Jira Folder Sorter]";

  /*
   * Folder names are intentionally NOT prefixed with "Jira:".
   */
  const MAX_FOLDER_NAME_LENGTH = 70;


  // ================================================================
  // Logging
  // ================================================================

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }


  // ================================================================
  // Preferences
  // ================================================================

  function getBoolPref(name, fallback) {
    try {
      return Services.prefs.getBoolPref(name, fallback);
    } catch {
      return fallback;
    }
  }

  function getStringPref(name, fallback) {
    try {
      return Services.prefs.getStringPref(name, fallback);
    } catch {
      return fallback;
    }
  }


  // ================================================================
  // Jira URL
  // ================================================================

  function parseJiraUrl(urlString, baseUrlString) {
    if (!urlString || !baseUrlString) {
      return null;
    }

    let url;
    let base;

    try {
      url = new URL(urlString);
      base = new URL(baseUrlString);
    } catch {
      return null;
    }

    if (url.hostname !== base.hostname) {
      return null;
    }

    let match = url.pathname.match(
      /\/browse\/([A-Z][A-Z0-9_]*-\d+)/i
    );

    if (!match) {
      match = url.search.match(
        /[?&]selectedIssue=([A-Z][A-Z0-9_]*-\d+)/i
      );
    }

    if (!match) {
      return null;
    }

    const issueKey = match[1].toUpperCase();

    return {
      issueKey,
      projectKey: issueKey.split("-")[0],
    };
  }


  // ================================================================
  // Jira title
  // ================================================================

  function getIssueTitle(tab, issueKey) {
    let title = "";

    try {
      title = tab.linkedBrowser?.contentTitle || "";
    } catch {}

    if (!title) {
      try {
        title = tab.label || "";
      } catch {}
    }

    if (!title) {
      return issueKey;
    }

    title = title
      .replace(/\s*[-|]\s*Jira.*$/i, "")
      .replace(/\s*[-|]\s*Atlassian.*$/i, "")
      .trim();

    title = title
      .replace(
        new RegExp(
          `\\b${escapeRegExp(issueKey)}\\b`,
          "i"
        ),
        ""
      )
      .replace(/^[\s\-:|]+/, "")
      .replace(/[\s\-:|]+$/, "")
      .trim();

    return title || issueKey;
  }


  function escapeRegExp(value) {
    return value.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
  }


  // ================================================================
  // Folder name
  // ================================================================

  function makeFolderName(issueKey, title) {
    let name = `${issueKey} ${title}`.trim();

    if (name.length > MAX_FOLDER_NAME_LENGTH) {
      name =
        name.slice(
          0,
          MAX_FOLDER_NAME_LENGTH - 3
        ) + "...";
    }

    return name;
  }


  // ================================================================
  // Zen folder detection
  // ================================================================

  function getZenFolders() {
    return Array.from(
      document.querySelectorAll("zen-folder")
    );
  }


  function isZenFolder(folder) {
    return !!folder?.isZenFolder;
  }


  function findFolder(label) {
    for (const folder of getZenFolders()) {
      if (
        isZenFolder(folder) &&
        folder.label === label
      ) {
        return folder;
      }
    }

    return null;
  }


  // ================================================================
  // Opener detection
  // ================================================================

  function getOpenerTab(tab) {
    try {
      const openerBrowser =
        tab.linkedBrowser
          ?.frameLoader
          ?.browsingContext
          ?.opener
          ?.top
          ?.embedderElement;

      if (!openerBrowser) {
        return null;
      }

      return gBrowser.getTabForBrowser(
        openerBrowser
      );
    } catch {
      return null;
    }
  }


  function findParentFolder(tab) {
    const visited = new Set();

    let current = getOpenerTab(tab);

    while (
      current &&
      !visited.has(current)
    ) {
      visited.add(current);

      if (
        current.group &&
        isZenFolder(current.group)
      ) {
        return current.group;
      }

      current = getOpenerTab(current);
    }

    return null;
  }


  // ================================================================
  // REAL ZEN FOLDER CREATION
  // ================================================================

  function createFolder(tab, label) {
    if (
      typeof gZenFolders === "undefined" ||
      !gZenFolders ||
      typeof gZenFolders.createFolder !== "function"
    ) {
      warn(
        "Zen folder API is unavailable."
      );

      return null;
    }

    try {
      /*
       * IMPORTANT:
       *
       * This intentionally mirrors Zen's own
       * context-menu implementation.
       *
       * We do NOT pass workspaceId.
       * We do NOT manually create a zen-folder.
       * We do NOT manually create an empty tab.
       * We do NOT manually pin anything.
       *
       * Zen does all of that.
       */

      const folder =
        gZenFolders.createFolder(
          [tab],
          {
            renameFolder: false,
          }
        );

      if (!folder) {
        warn(
          "Zen returned no folder."
        );

        return null;
      }

      /*
       * Zen defaults the label to "New Folder".
       * Set the label using the actual Zen folder object.
       */
      folder.label = label;

      /*
       * Force the folder state to be persisted immediately.
       */
      try {
        for (const folderTab of folder.tabs) {
          if (
            folderTab.linkedBrowser
          ) {
            gBrowser.TabStateFlusher.flush(
              folderTab.linkedBrowser
            );
          }
        }
      } catch {}

      log(
        `Created Zen folder "${label}".`
      );

      return folder;

    } catch (e) {
      warn(
        "Zen folder creation failed:",
        e
      );

      return null;
    }
  }


  // ================================================================
  // Add tab to existing Zen folder
  // ================================================================

  function addToFolder(folder, tab) {
    if (
      !folder ||
      !tab ||
      !isZenFolder(folder)
    ) {
      return false;
    }

    try {
      /*
       * This is the exact operation Zen's own
       * "Move to Folder" context menu uses.
       */
      folder.addTabs([tab]);

      log(
        `Moved "${tab.label}" into "${folder.label}".`
      );

      return true;
    } catch (e) {
      warn(
        "Could not add tab to Zen folder:",
        e
      );

      return false;
    }
  }


  // ================================================================
  // Organize Jira tab
  // ================================================================

  function organizeTab(tab, issueKey) {
    if (
      !tab ||
      tab.closing
    ) {
      return;
    }

    /*
     * Don't interfere with anything already
     * inside a Zen folder.
     */
    if (
      tab.group &&
      isZenFolder(tab.group)
    ) {
      return;
    }

    /*
     * Don't interfere with ordinary tab groups
     * created by the user.
     */
    if (
      tab.group &&
      !isZenFolder(tab.group)
    ) {
      return;
    }


    // --------------------------------------------------------------
    // Try to inherit the opener's folder.
    // --------------------------------------------------------------

    const parentFolder =
      findParentFolder(tab);

    if (parentFolder) {
      if (
        addToFolder(
          parentFolder,
          tab
        )
      ) {
        return;
      }
    }


    // --------------------------------------------------------------
    // Otherwise create/reuse a folder for this issue.
    // --------------------------------------------------------------

    const title =
      getIssueTitle(
        tab,
        issueKey
      );

    const folderName =
      makeFolderName(
        issueKey,
        title
      );

    let folder =
      findFolder(folderName);

    if (folder) {
      addToFolder(
        folder,
        tab
      );

      return;
    }

    createFolder(
      tab,
      folderName
    );
  }


  // ================================================================
  // Handle Jira tab
  // ================================================================

  async function handleTab(tab) {
    if (
      !getBoolPref(
        PREF_ENABLED,
        true
      )
    ) {
      return;
    }

    if (
      !tab ||
      tab.closing
    ) {
      return;
    }

    const browser =
      tab.linkedBrowser;

    if (
      !browser ||
      !browser.currentURI
    ) {
      return;
    }

    const url =
      browser.currentURI.spec;

    if (
      !url ||
      url === "about:blank"
    ) {
      return;
    }

    const baseUrl =
      getStringPref(
        PREF_BASE_URL,
        ""
      );

    if (!baseUrl) {
      return;
    }

    const parsed =
      parseJiraUrl(
        url,
        baseUrl
      );

    if (!parsed) {
      return;
    }

    /*
     * Jira is a SPA, so wait for the title to settle.
     */
    await new Promise(resolve =>
      setTimeout(resolve, 700)
    );

    if (tab.closing) {
      return;
    }

    organizeTab(
      tab,
      parsed.issueKey
    );
  }


  // ================================================================
  // Navigation listener
  // ================================================================

  function attachListener(tab) {
    if (!tab) {
      return;
    }

    const browser =
      tab.linkedBrowser;

    if (!browser) {
      return;
    }

    if (
      tab._jiraFolderSorterListener
    ) {
      return;
    }

    const listener = {
      QueryInterface:
        ChromeUtils.generateQI([
          "nsIWebProgressListener",
          "nsISupportsWeakReference",
        ]),

      onLocationChange(
        webProgress
      ) {
        if (
          !webProgress.isTopLevel
        ) {
          return;
        }

        setTimeout(
          () => handleTab(tab),
          500
        );
      },

      onStateChange() {},
      onProgressChange() {},
      onStatusChange() {},
      onSecurityChange() {},
      onContentBlockingEvent() {},
    };

    try {
      browser.addProgressListener(
        listener,
        Ci.nsIWebProgress.NOTIFY_LOCATION
      );

      tab._jiraFolderSorterListener =
        listener;

      tab.addEventListener(
        "TabClose",
        () => {
          try {
            browser.removeProgressListener(
              listener
            );
          } catch {}

          delete tab._jiraFolderSorterListener;
        },
        { once: true }
      );

    } catch (e) {
      warn(
        "Could not attach listener:",
        e
      );
    }
  }


  // ================================================================
  // New tab
  // ================================================================

  function onTabOpen(event) {
    const tab =
      event.target;

    if (!tab) {
      return;
    }

    attachListener(tab);

    if (
      tab.linkedBrowser?.currentURI &&
      tab.linkedBrowser.currentURI.spec !==
        "about:blank"
    ) {
      setTimeout(
        () => handleTab(tab),
        700
      );
    }
  }


  // ================================================================
  // Init
  // ================================================================

  function init() {
    if (
      !gBrowser ||
      !gBrowser.tabContainer
    ) {
      return;
    }

    log(
      "Jira Folder Sorter starting..."
    );

    log(
      "gZenFolders:",
      typeof gZenFolders !== "undefined"
        ? "available"
        : "NOT AVAILABLE"
    );

    gBrowser.tabContainer.addEventListener(
      "TabOpen",
      onTabOpen
    );

    for (
      const tab of gBrowser.tabs
    ) {
      attachListener(tab);

      if (
        tab.linkedBrowser?.currentURI &&
        tab.linkedBrowser.currentURI.spec !==
          "about:blank"
      ) {
        setTimeout(
          () => handleTab(tab),
          700
        );
      }
    }

    log(
      "initialized."
    );
  }


  // ================================================================
  // Wait for Zen startup
  // ================================================================

  if (
    typeof gBrowserInit !== "undefined" &&
    gBrowserInit.delayedStartupFinished
  ) {
    init();
  } else {
    const observer = (
      subject,
      topic
    ) => {
      if (subject === window) {
        Services.obs.removeObserver(
          observer,
          topic
        );

        init();
      }
    };

    Services.obs.addObserver(
      observer,
      "browser-delayed-startup-finished"
    );
  }

})();
