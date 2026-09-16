// ==UserScript==
// @name        Jira Folder Sorter
// @description Automatically organizes Jira tabs into native Zen folders.
//              Uses Zen's own folder implementation. No Jira API required.
// @version     1.1.0
// ==/UserScript==

(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") {
    return;
  }

  /*
   * ================================================================
   * SETTINGS
   * ================================================================
   */

  const PREF_ENABLED =
    "extensions.jira-folder-sorter.enabled";

  const PREF_BASE_URL =
    "extensions.jira-folder-sorter.jira-base-url";


  /*
   * ================================================================
   * CONSTANTS
   * ================================================================
   */

  const LOG_PREFIX = "[Jira Folder Sorter]";

  /*
   * We mark folders created by this script so that we never
   * interfere with folders you created manually.
   */
  const FOLDER_PREFIX = "Jira: ";

  const MAX_FOLDER_NAME_LENGTH = 70;


  /*
   * ================================================================
   * LOGGING
   * ================================================================
   */

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }


  /*
   * ================================================================
   * PREFERENCES
   * ================================================================
   */

  function getBoolPref(name, fallback) {
    try {
      return Services.prefs.getBoolPref(name, fallback);
    } catch (e) {
      return fallback;
    }
  }

  function getStringPref(name, fallback) {
    try {
      const value = Services.prefs.getStringPref(name, fallback);
      return value == null ? fallback : value;
    } catch (e) {
      return fallback;
    }
  }


  /*
   * ================================================================
   * JIRA URL
   * ================================================================
   */

  function parseJiraUrl(urlString, baseUrlString) {
    if (!urlString || !baseUrlString) {
      return null;
    }

    let url;
    let base;

    try {
      url = new URL(urlString);
      base = new URL(baseUrlString);
    } catch (e) {
      return null;
    }

    /*
     * Only accept our configured Jira instance.
     */
    if (url.hostname !== base.hostname) {
      return null;
    }

    let match = url.pathname.match(
      /\/browse\/([A-Z][A-Z0-9_]*-\d+)/i
    );

    /*
     * Some Jira URLs use selectedIssue instead.
     */
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


  /*
   * ================================================================
   * TAB TITLE
   * ================================================================
   */

  function getIssueTitle(tab, issueKey) {
    if (!tab) {
      return issueKey;
    }

    let title = "";

    try {
      title = tab.linkedBrowser?.contentTitle || "";
    } catch (e) {
      // Ignore.
    }

    if (!title) {
      try {
        title = tab.label || "";
      } catch (e) {
        // Ignore.
      }
    }

    if (!title) {
      return issueKey;
    }

    /*
     * Jira commonly produces titles such as:
     *
     *   ABC-123 Login redesign
     *   Login redesign - ABC-123
     *   Login redesign | Jira
     */

    title = title
      .replace(/\s*[-|]\s*Jira.*$/i, "")
      .replace(/\s*[-|]\s*Atlassian.*$/i, "")
      .trim();

    title = title
      .replace(
        new RegExp(`\\b${escapeRegExp(issueKey)}\\b`, "i"),
        ""
      )
      .replace(/^[\s\-:|]+/, "")
      .replace(/[\s\-:|]+$/, "")
      .trim();

    return title || issueKey;
  }


  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }


  /*
   * ================================================================
   * FOLDER NAME
   * ================================================================
   *
   * We intentionally don't try to determine Epic/Story through Jira's
   * API.
   *
   * Without the API, the browser does not know the actual Jira parent
   * relationship from the URL alone.
   *
   * Therefore:
   *
   *   first issue -> creates the folder
   *
   *   issues opened from that Jira tab -> inherit the folder
   *
   * This works particularly well for Epic -> Story workflows.
   */

  function makeFolderName(issueKey, title) {
    let name = `${issueKey} ${title}`.trim();

    if (name.length > MAX_FOLDER_NAME_LENGTH) {
      name =
        name.slice(0, MAX_FOLDER_NAME_LENGTH - 3) +
        "...";
    }

    return `${FOLDER_PREFIX}${name}`;
  }


  /*
   * ================================================================
   * REAL ZEN FOLDERS
   * ================================================================
   */

  function getZenFolders() {
    /*
     * Zen folders are actual <zen-folder> elements.
     *
     * This is intentionally NOT:
     *
     *   gBrowser.tabGroups
     *
     * because that also contains ordinary Firefox tab groups.
     */

    try {
      return Array.from(
        document.querySelectorAll("zen-folder")
      );
    } catch (e) {
      warn("Unable to enumerate Zen folders:", e);
      return [];
    }
  }


  function isZenFolder(folder) {
    return !!(
      folder &&
      folder.isZenFolder
    );
  }


  function isOurFolder(folder) {
    if (!isZenFolder(folder)) {
      return false;
    }

    return (
      typeof folder.label === "string" &&
      folder.label.startsWith(FOLDER_PREFIX)
    );
  }


  function findOurFolder(label) {
    if (!label) {
      return null;
    }

    for (const folder of getZenFolders()) {
      if (
        isOurFolder(folder) &&
        folder.label === label
      ) {
        return folder;
      }
    }

    return null;
  }


  /*
   * ================================================================
   * FIND OPENER
   * ================================================================
   */

  function getOpenerTab(tab) {
    if (!tab) {
      return null;
    }

    try {
      const browser = tab.linkedBrowser;

      if (!browser) {
        return null;
      }

      const openerBrowser =
        browser.frameLoader
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
    } catch (e) {
      return null;
    }
  }


  /*
   * Walk through the opener chain looking for one of our
   * real Zen folders.
   */
  function findInheritedFolder(tab) {
    const visited = new Set();

    let current = getOpenerTab(tab);

    while (
      current &&
      !visited.has(current)
    ) {
      visited.add(current);

      const group = current.group;

      if (
        group &&
        isZenFolder(group) &&
        isOurFolder(group)
      ) {
        return group;
      }

      current = getOpenerTab(current);
    }

    return null;
  }


  /*
   * ================================================================
   * CREATE REAL ZEN FOLDER
   * ================================================================
   */

  function createZenFolder(tab, label) {
    if (!tab || tab.closing) {
      return null;
    }

    /*
     * This is Zen's own folder manager.
     *
     * Zen's source uses:
     *
     *   gZenFolders.createFolder(tabs, options)
     *
     * to create folders.
     */

    if (
      typeof gZenFolders === "undefined" ||
      !gZenFolders ||
      typeof gZenFolders.createFolder !== "function"
    ) {
      warn(
        "gZenFolders.createFolder() is not available."
      );

      return null;
    }

    try {
      const folder =
        gZenFolders.createFolder(
          [tab],
          {
            label,
            workspaceId:
              gZenWorkspaces.activeWorkspace,

            /*
             * Put the folder before the normal
             * pinned-tabs separator, just like Zen's
             * own new-folder action.
             */
            insertBefore:
              gZenWorkspaces
                .pinnedTabsContainer
                ?.querySelector(
                  ".pinned-tabs-container-separator"
                ),

            /*
             * Do NOT open Zen's rename dialog.
             * We already know the name.
             */
            renameFolder: false,

            /*
             * Persist the folder like a normal
             * user-created folder.
             */
            saveOnWindowClose: true,
          }
        );

      if (!folder) {
        warn(
          `Zen failed to create folder "${label}".`
        );

        return null;
      }

      log(
        `Created real Zen folder "${label}".`
      );

      return folder;
    } catch (e) {
      warn(
        `Failed creating Zen folder "${label}":`,
        e
      );

      return null;
    }
  }


  /*
   * ================================================================
   * ADD TAB TO REAL ZEN FOLDER
   * ================================================================
   */

  function addTabToZenFolder(
    folder,
    tab
  ) {
    if (
      !folder ||
      !tab ||
      tab.closing
    ) {
      return false;
    }

    if (!isZenFolder(folder)) {
      warn(
        "Refusing to add tab to non-Zen folder."
      );

      return false;
    }

    try {
      /*
       * This is exactly what Zen's own
       * "Move to Folder" action does.
       *
       * Zen's source:
       *
       *   group.addTabs(tabs)
       */

      folder.addTabs([tab]);

      log(
        `Added "${tab.label}" to "${folder.label}".`
      );

      return true;
    } catch (e) {
      warn(
        `Failed adding "${tab.label}" to "${folder.label}":`,
        e
      );

      return false;
    }
  }


  /*
   * ================================================================
   * ORGANIZE TAB
   * ================================================================
   */

  function organizeTab(
    tab,
    issueKey
  ) {
    if (
      !tab ||
      tab.closing ||
      !issueKey
    ) {
      return;
    }

    /*
     * If the tab is already inside a real Zen folder,
     * don't touch it.
     */
    if (
      tab.group &&
      isZenFolder(tab.group)
    ) {
      return;
    }

    /*
     * If the user manually put the tab into a normal
     * tab group, don't interfere.
     */
    if (
      tab.group &&
      !isZenFolder(tab.group)
    ) {
      return;
    }

    /*
     * ------------------------------------------------------------
     * 1. Try to inherit the folder from the Jira tab that
     *    opened this tab.
     * ------------------------------------------------------------
     */

    const inheritedFolder =
      findInheritedFolder(tab);

    if (inheritedFolder) {
      if (
        addTabToZenFolder(
          inheritedFolder,
          tab
        )
      ) {
        log(
          `${issueKey} inherited folder "${inheritedFolder.label}".`
        );

        return;
      }
    }

    /*
     * ------------------------------------------------------------
     * 2. No parent folder was found.
     *
     *    Create/reuse a folder based on this issue.
     * ------------------------------------------------------------
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
      findOurFolder(folderName);

    /*
     * Existing folder.
     */
    if (folder) {
      addTabToZenFolder(
        folder,
        tab
      );

      return;
    }

    /*
     * New real Zen folder.
     */
    folder =
      createZenFolder(
        tab,
        folderName
      );

    if (!folder) {
      warn(
        `Could not organize Jira issue ${issueKey}.`
      );
    }
  }


  /*
   * ================================================================
   * HANDLE JIRA TAB
   * ================================================================
   */

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
     * Jira is a SPA.
     *
     * Give it a moment to update the title after
     * navigation.
     */
    await new Promise(
      resolve =>
        setTimeout(resolve, 600)
    );

    if (tab.closing) {
      return;
    }

    organizeTab(
      tab,
      parsed.issueKey
    );
  }


  /*
   * ================================================================
   * NAVIGATION LISTENER
   * ================================================================
   */

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

        /*
         * Let Jira finish rendering.
         */
        setTimeout(
          () => {
            handleTab(tab);
          },
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
          } catch (e) {
            // Browser already destroyed.
          }

          delete tab._jiraFolderSorterListener;
        },
        { once: true }
      );
    } catch (e) {
      warn(
        "Could not attach Jira listener:",
        e
      );
    }
  }


  /*
   * ================================================================
   * TAB OPEN
   * ================================================================
   */

  function onTabOpen(event) {
    const tab =
      event.target;

    if (!tab) {
      return;
    }

    attachListener(tab);

    /*
     * Handle tabs that were opened directly
     * with an already-loaded URL.
     */
    if (
      tab.linkedBrowser &&
      tab.linkedBrowser.currentURI &&
      tab.linkedBrowser.currentURI.spec !==
        "about:blank"
    ) {
      setTimeout(
        () => {
          handleTab(tab);
        },
        700
      );
    }
  }


  /*
   * ================================================================
   * INITIALIZATION
   * ================================================================
   */

  function init() {
    if (
      !gBrowser ||
      !gBrowser.tabContainer
    ) {
      warn(
        "gBrowser is not ready."
      );

      return;
    }

    /*
     * Make sure Zen's folder manager exists.
     */
    if (
      typeof gZenFolders ===
        "undefined" ||
      !gZenFolders
    ) {
      warn(
        "gZenFolders is not available yet."
      );
    } else {
      log(
        "Zen folder manager detected."
      );
    }

    gBrowser.tabContainer.addEventListener(
      "TabOpen",
      onTabOpen
    );

    /*
     * Existing tabs.
     */
    for (
      const tab of gBrowser.tabs
    ) {
      attachListener(tab);

      if (
        tab.linkedBrowser &&
        tab.linkedBrowser.currentURI &&
        tab.linkedBrowser.currentURI.spec !==
          "about:blank"
      ) {
        setTimeout(
          () => {
            handleTab(tab);
          },
          700
        );
      }
    }

    log(
      "Jira Folder Sorter initialized."
    );
  }


  /*
   * ================================================================
   * WAIT FOR ZEN STARTUP
   * ================================================================
   */

  if (
    typeof gBrowserInit !==
      "undefined" &&
    gBrowserInit.delayedStartupFinished
  ) {
    init();
  } else {
    const observer = (
      subject,
      topic
    ) => {
      if (
        subject === window
      ) {
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
