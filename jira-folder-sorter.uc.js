// ==UserScript==
// @name        Jira Folder Sorter
// @description Automatically organizes Jira tabs into native Zen folders.
//              No Jira API, email, or API token required.
// @version     1.0.0
// ==/UserScript==

(function () {
  "use strict";

  if (location.href !== "chrome://browser/content/browser.xhtml") {
    return;
  }

  /*
   * ================================================================
   * CONFIGURATION
   * ================================================================
   */

  const PREF_ENABLED =
    "extensions.jira-folder-sorter.enabled";

  const PREF_BASE_URL =
    "extensions.jira-folder-sorter.jira-base-url";

  const PREF_COLOR =
    "extensions.jira-folder-sorter.group-color";


  /*
   * ================================================================
   * CONSTANTS
   * ================================================================
   */

  const LOG_PREFIX = "[Jira Folder Sorter]";

  // Every folder created by this script gets this prefix internally.
  // This lets us distinguish our folders from folders created manually.
  const FOLDER_PREFIX = "Jira: ";

  // Maximum number of characters used for a folder name.
  const MAX_FOLDER_LENGTH = 70;


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
   * JIRA URL PARSING
   * ================================================================
   *
   * Examples:
   *
   * https://company.atlassian.net/browse/ABC-123
   * https://company.atlassian.net/issues/?jql=...
   *
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

    // Only accept the configured Jira domain.
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


  /*
   * ================================================================
   * TAB TITLE
   * ================================================================
   */

  function getTabTitle(tab) {
    if (!tab) {
      return "";
    }

    const browser = tab.linkedBrowser;

    if (!browser) {
      return "";
    }

    let title = "";

    try {
      title = browser.contentTitle || "";
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

    return cleanTitle(title);
  }

  function cleanTitle(title) {
    if (!title) {
      return "";
    }

    /*
     * Jira titles commonly look like:
     *
     *   ABC-123 Login redesign
     *   Login redesign - ABC-123
     *   Login redesign | Jira
     *
     * Remove the common Jira suffixes.
     */

    return title
      .replace(/\s*[-|]\s*Jira.*$/i, "")
      .replace(/\s*[-|]\s*Atlassian.*$/i, "")
      .trim();
  }


  /*
   * ================================================================
   * ISSUE INFORMATION
   * ================================================================
   */

  function getIssueInfo(tab, parsed) {
    if (!tab || !parsed) {
      return null;
    }

    const title = getTabTitle(tab);

    /*
     * Try to extract the issue key from the title.
     */
    let titleWithoutKey = title
      .replace(
        new RegExp(
          `\\b${escapeRegExp(parsed.issueKey)}\\b`,
          "i"
        ),
        ""
      )
      .trim();

    titleWithoutKey = titleWithoutKey
      .replace(/^[\s\-:|]+/, "")
      .replace(/[\s\-:|]+$/, "")
      .trim();

    return {
      key: parsed.issueKey,
      project: parsed.projectKey,
      title: titleWithoutKey || parsed.issueKey,
    };
  }


  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }


  /*
   * ================================================================
   * FOLDER NAME
   * ================================================================
   *
   * Without the Jira API we cannot reliably know:
   *
   *     Story -> Epic
   *
   * from the URL alone.
   *
   * Therefore the default no-API behavior is:
   *
   *     ABC-123 Login redesign
   *
   * becomes:
   *
   *     Jira: ABC-123 Login redesign
   *
   * If a tab was opened from another Jira issue that already belongs
   * to a Jira folder, we can instead inherit that folder.
   */

  function makeFolderName(issue) {
    if (!issue) {
      return null;
    }

    let name = issue.key;

    if (issue.title && issue.title !== issue.key) {
      name += " " + issue.title;
    }

    name = name.trim();

    if (name.length > MAX_FOLDER_LENGTH) {
      name = name.slice(0, MAX_FOLDER_LENGTH - 3) + "...";
    }

    return FOLDER_PREFIX + name;
  }


  /*
   * ================================================================
   * FIND JIRA FOLDERS
   * ================================================================
   */

  function getAllGroups() {
    try {
      return Array.from(gBrowser.tabGroups || []);
    } catch (e) {
      return [];
    }
  }

  function isOurFolder(group) {
    if (!group) {
      return false;
    }

    return (
      typeof group.label === "string" &&
      group.label.startsWith(FOLDER_PREFIX)
    );
  }

  function findFolder(label) {
    if (!label) {
      return null;
    }

    for (const group of getAllGroups()) {
      if (group.label === label) {
        return group;
      }
    }

    return null;
  }


  /*
   * ================================================================
   * DETECT PARENT JIRA FOLDER
   * ================================================================
   *
   * This is the key no-API optimization.
   *
   * If you are viewing:
   *
   *     Jira Epic ABC-100
   *
   * and open:
   *
   *     Story ABC-101
   *
   * from that Jira page, the new tab often has an opener pointing
   * to the Epic tab.
   *
   * If the opener is already in one of our Jira folders, we reuse
   * that folder.
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

      const openerBrowser = browser.frameLoader?.browsingContext?.opener
        ?.top?.embedderElement;

      if (openerBrowser) {
        return gBrowser.getTabForBrowser(openerBrowser);
      }
    } catch (e) {
      // Some navigation types do not expose an opener.
    }

    return null;
  }


  function findInheritedJiraFolder(tab) {
    let opener = getOpenerTab(tab);

    if (!opener) {
      return null;
    }

    /*
     * Walk backwards through the opener chain.
     *
     * This helps with:
     *
     * Epic
     *   -> Story
     *       -> Task
     *
     * even if the immediate opener isn't available anymore.
     */

    const visited = new Set();

    while (opener && !visited.has(opener)) {
      visited.add(opener);

      if (opener.group && isOurFolder(opener.group)) {
        return opener.group;
      }

      opener = getOpenerTab(opener);
    }

    return null;
  }


  /*
   * ================================================================
   * CREATE ZEN FOLDER
   * ================================================================
   */

  function createFolder(tab, label, color) {
    if (!tab || tab.closing || !label) {
      return null;
    }

    try {
      /*
       * Zen/Firefox cannot create a completely empty tab group.
       *
       * Therefore the first Jira tab becomes the initial member.
       */
      const group = gBrowser.addTabGroup(
        [tab],
        {
          label,
          color: color || "blue",
          showCreateUI: false,
          insertBefore: tab,
        }
      );

      if (group) {
        log(`Created folder: ${label}`);
      }

      return group;
    } catch (e) {
      warn(`Could not create folder "${label}"`, e);
      return null;
    }
  }


  /*
   * ================================================================
   * MOVE TAB INTO EXISTING FOLDER
   * ================================================================
   */

  function moveTabToFolder(tab, group) {
    if (!tab || !group || tab.closing) {
      return false;
    }

    if (tab.group === group) {
      return true;
    }

    try {
      gBrowser.moveTabToExistingGroup(tab, group);

      return tab.group === group;
    } catch (e) {
      warn(
        `Could not move tab "${tab.label}" into folder "${group.label}"`,
        e
      );

      return false;
    }
  }


  /*
   * ================================================================
   * MAIN FOLDER LOGIC
   * ================================================================
   */

  function organizeTab(tab, issue) {
    if (!tab || !issue || tab.closing) {
      return;
    }

    /*
     * IMPORTANT:
     *
     * Never interfere with folders the user created manually.
     *
     * If the tab is already in a normal Zen folder, leave it alone.
     */
    if (tab.group && !isOurFolder(tab.group)) {
      log(
        `Skipping "${issue.key}" because it is already in a user folder`
      );
      return;
    }

    /*
     * If the tab is already in one of our folders, leave it there.
     */
    if (tab.group && isOurFolder(tab.group)) {
      return;
    }

    /*
     * --------------------------------------------------------------
     * FIRST TRY:
     *
     * If this Jira tab was opened from another Jira tab that already
     * belongs to one of our folders, inherit that folder.
     *
     * This gives us parent/child organization without the Jira API.
     * --------------------------------------------------------------
     */

    const inheritedFolder = findInheritedJiraFolder(tab);

    if (inheritedFolder) {
      if (moveTabToFolder(tab, inheritedFolder)) {
        log(
          `${issue.key} inherited folder "${inheritedFolder.label}"`
        );
        return;
      }
    }

    /*
     * --------------------------------------------------------------
     * SECOND TRY:
     *
     * Create/find a folder for this issue.
     *
     * Example:
     *
     * Jira: PROJ-123 Login redesign
     * --------------------------------------------------------------
     */

    const folderName = makeFolderName(issue);

    if (!folderName) {
      return;
    }

    const color = getStringPref(
      PREF_COLOR,
      "blue"
    );

    let folder = findFolder(folderName);

    /*
     * Existing folder.
     */
    if (folder) {
      if (moveTabToFolder(tab, folder)) {
        log(
          `Moved ${issue.key} into "${folderName}"`
        );
      }

      return;
    }

    /*
     * No folder yet.
     *
     * Creating the folder automatically places this tab inside it.
     */
    folder = createFolder(
      tab,
      folderName,
      color
    );

    if (!folder) {
      warn(
        `Unable to organize ${issue.key}`
      );
    }
  }


  /*
   * ================================================================
   * HANDLE TAB
   * ================================================================
   */

  async function handleTab(tab) {
    if (!getBoolPref(PREF_ENABLED, true)) {
      return;
    }

    if (!tab || tab.closing) {
      return;
    }

    const browser = tab.linkedBrowser;

    if (!browser || !browser.currentURI) {
      return;
    }

    const url = browser.currentURI.spec;

    if (!url || url === "about:blank") {
      return;
    }

    const baseUrl = getStringPref(
      PREF_BASE_URL,
      ""
    );

    if (!baseUrl) {
      return;
    }

    const parsed = parseJiraUrl(
      url,
      baseUrl
    );

    if (!parsed) {
      return;
    }

    /*
     * Wait a little bit for Jira's title to finish loading.
     *
     * Jira is a SPA and the initial document title can be incomplete.
     */
    await new Promise(resolve =>
      setTimeout(resolve, 500)
    );

    if (tab.closing) {
      return;
    }

    const issue = getIssueInfo(
      tab,
      parsed
    );

    if (!issue) {
      return;
    }

    log(
      `Detected Jira issue: ${issue.key} "${issue.title}"`
    );

    organizeTab(
      tab,
      issue
    );
  }


  /*
   * ================================================================
   * TAB OPEN / NAVIGATION LISTENER
   * ================================================================
   */

  function attachProgressListener(tab) {
    if (!tab) {
      return;
    }

    const browser = tab.linkedBrowser;

    if (!browser) {
      return;
    }

    /*
     * Prevent attaching multiple listeners to the same tab.
     */
    if (tab._jiraFolderSorterListener) {
      return;
    }

    const listener = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),

      onLocationChange(webProgress) {
        if (!webProgress.isTopLevel) {
          return;
        }

        /*
         * Jira changes URL/title dynamically.
         * Give the SPA a moment to render.
         */
        setTimeout(() => {
          handleTab(tab);
        }, 300);
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

      tab._jiraFolderSorterListener = listener;

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
        "Could not attach Jira navigation listener:",
        e
      );
    }
  }


  function onTabOpen(event) {
    const tab = event.target;

    if (!tab) {
      return;
    }

    attachProgressListener(tab);

    /*
     * Handle tabs opened with an already-loaded URL.
     */
    const browser = tab.linkedBrowser;

    if (
      browser &&
      browser.currentURI &&
      browser.currentURI.spec !== "about:blank"
    ) {
      setTimeout(() => {
        handleTab(tab);
      }, 500);
    }
  }


  /*
   * ================================================================
   * INITIALIZATION
   * ================================================================
   */

  function init() {
    if (!gBrowser || !gBrowser.tabContainer) {
      warn("gBrowser not ready");
      return;
    }

    gBrowser.tabContainer.addEventListener(
      "TabOpen",
      onTabOpen
    );

    /*
     * Attach to tabs that already exist when the script loads.
     */
    for (const tab of gBrowser.tabs) {
      attachProgressListener(tab);

      if (
        tab.linkedBrowser &&
        tab.linkedBrowser.currentURI &&
        tab.linkedBrowser.currentURI.spec !== "about:blank"
      ) {
        setTimeout(() => {
          handleTab(tab);
        }, 500);
      }
    }

    log("initialized");
  }


  /*
   * ================================================================
   * WAIT FOR BROWSER STARTUP
   * ================================================================
   */

  if (
    typeof gBrowserInit !== "undefined" &&
    gBrowserInit.delayedStartupFinished
  ) {
    init();
  } else {
    const observer = (subject, topic) => {
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
