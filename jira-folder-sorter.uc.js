// ==UserScript==
// @name        Jira Folder Sorter
// @description Automatically organizes Jira tabs into native Zen folders.
// @version     1.3.0
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

  const MAX_FOLDER_NAME_LENGTH = 70;

  /*
   * Remember which folder a newly opened tab should inherit.
   *
   * This is intentionally separate from the browser's opener
   * relationship because Jira/Zen can sometimes clear the opener
   * relationship after the new tab starts navigating.
   */
  const pendingParentFolders = new WeakMap();

  /*
   * Keep track of folders created by this script.
   * This lets us safely remove empty ones without touching
   * folders created manually by the user.
   */
  const managedFolders = new WeakSet();


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
      .replace(/\s*[-|–—]\s*Jira.*$/i, "")
      .replace(/\s*[-|–—]\s*Atlassian.*$/i, "")
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

    /*
     * The opener may already have disappeared by the time Jira
     * finishes navigation. Check the folder remembered when the
     * tab was originally opened.
     */
    return pendingParentFolders.get(tab) || null;
  }


  // ================================================================
  // Remember folder when a new tab is opened
  // ================================================================

  function rememberParentFolder(tab) {
    if (!tab) {
      return;
    }

    /*
     * First try the actual browser opener.
     */
    const openerTab = getOpenerTab(tab);

    if (
      openerTab &&
      openerTab.group &&
      isZenFolder(openerTab.group)
    ) {
      pendingParentFolders.set(
        tab,
        openerTab.group
      );

      log(
        `Remembered parent folder "${openerTab.group.label}" for new tab.`
      );

      return;
    }

    /*
     * Sometimes the opener is exposed a little later.
     * Try again after the tab has been initialized.
     */
    setTimeout(() => {
      if (!tab || tab.closing) {
        return;
      }

      const delayedOpener =
        getOpenerTab(tab);

      if (
        delayedOpener &&
        delayedOpener.group &&
        isZenFolder(delayedOpener.group)
      ) {
        pendingParentFolders.set(
          tab,
          delayedOpener.group
        );

        log(
          `Remembered parent folder "${delayedOpener.group.label}" for new tab.`
        );
      }
    }, 50);
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

      folder.label = label;

      managedFolders.add(folder);

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
     * If the tab was opened from another tab that belongs
     * to a Zen folder, ALWAYS inherit that folder.
     *
     * This is checked before creating/reusing a folder
     * for the individual issue.
     */
    const parentFolder =
      findParentFolder(tab);

    if (parentFolder) {
      if (
        addToFolder(
          parentFolder,
          tab
        )
      ) {
        pendingParentFolders.delete(tab);
        return;
      }
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

    /*
     * Otherwise create/reuse a folder for the
     * first issue in this chain.
     */
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
  // Delete empty managed folders
  // ================================================================

  function cleanupFolder(folder) {
    if (
      !folder ||
      !folder.isConnected ||
      !managedFolders.has(folder)
    ) {
      return;
    }

    try {
      /*
       * Zen folders contain an internal empty tab.
       * Only count actual user tabs here.
       */
      const realTabs =
        Array.from(folder.tabs || []).filter(
          tab =>
            !tab.hasAttribute(
              "zen-empty-tab"
            ) &&
            !tab._forZenEmptyTab
        );

      if (realTabs.length > 0) {
        return;
      }

      log(
        `Deleting empty folder "${folder.label}".`
      );

      managedFolders.delete(folder);

      folder.delete();

    } catch (e) {
      warn(
        "Could not clean up empty folder:",
        e
      );
    }
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

          cleanupFolder(
            tab.group
          );

          pendingParentFolders.delete(
            tab
          );

          delete tab._jiraFolderSorterListener;

          /*
           * Zen may remove the tab from its folder
           * immediately after TabClose fires, so check
           * once more after the close has propagated.
           */
          setTimeout(() => {
            cleanupFolder(
              tab.group
            );

            for (
              const folder of getZenFolders()
            ) {
              cleanupFolder(folder);
            }
          }, 100);
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

    /*
     * IMPORTANT:
     *
     * Capture the parent folder immediately.
     * We cannot rely only on openerTab later because Jira
     * navigation can change the browsing context.
     */
    rememberParentFolder(tab);

    attachListener(tab);

    /*
     * If the tab already has a URL, process it.
     */
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
