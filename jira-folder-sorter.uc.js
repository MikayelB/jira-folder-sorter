// ==UserScript==
	
// @name        Jira Folder Sorter
	
// @description Automatically organizes Jira tabs into native Zen folders.
	
// @version     1.4.0
	
// ==/UserScript==
	
(function () {
  "use strict";

  const PREF_ENABLED = "extensions.jira-folder-sorter.enabled";
  const PREF_BASE_URL = "extensions.jira-folder-sorter.jira-base-url";

  const managedFolders = new Set();
  const folderByIssue = new Map();

  function isEnabled() {
    try {
      return Services.prefs.getBoolPref(PREF_ENABLED);
    } catch {
      return true;
    }
  }

  function getBaseUrl() {
    try {
      return Services.prefs
        .getCharPref(PREF_BASE_URL)
        .replace(/\/+$/, "");
    } catch {
      return "";
    }
  }

  function getTabUrl(tab) {
    try {
      return tab?.linkedBrowser?.currentURI?.spec || "";
    } catch {
      return "";
    }
  }

  function getIssueKey(url) {
    if (!url) return null;

    const match = url.match(
      /\/browse\/([A-Z][A-Z0-9]+-\d+)/i
    );

    return match ? match[1].toUpperCase() : null;
  }

  function isJiraTab(tab) {
    const base = getBaseUrl();
    const url = getTabUrl(tab);

    return !!(
      base &&
      url &&
      url.startsWith(base + "/browse/")
    );
  }

  function getSummary(tab) {
    let title = "";

    try {
      title = tab.linkedBrowser?.contentTitle || "";
    } catch {}

    if (!title) {
      title = tab.label || "";
    }

    if (!title) return null;

    title = title
      .replace(/\s*[-|–—]\s*Jira\s*$/i, "")
      .replace(/\s+Jira\s*$/i, "")
      .trim();

    const key = getIssueKey(getTabUrl(tab));

    if (key) {
      title = title
        .replace(
          new RegExp(
            "^" + key + "\\s*[-|:]?\\s*",
            "i"
          ),
          ""
        )
        .trim();
    }

    if (!title || /^Jira$/i.test(title)) {
      return null;
    }

    return title;
  }

  function getZenFolder(tab) {
    try {
      const group = tab?.group;

      if (group && group.isZenFolder) {
        return group;
      }
    } catch {}

    return null;
  }

  function findParentFolder(tab) {
    const visited = new Set();
    let current = tab;

    while (current) {
      if (visited.has(current)) {
        break;
      }

      visited.add(current);

      const folder = getZenFolder(current);

      if (folder && managedFolders.has(folder)) {
        return folder;
      }

      current =
        current.openerTab ||
        current.ownerTab ||
        null;
    }

    return null;
  }

  function findManagedFolder(issueKey) {
    if (!issueKey) return null;

    const cached = folderByIssue.get(issueKey);

    if (
      cached &&
      cached.isConnected &&
      cached.isZenFolder
    ) {
      return cached;
    }

    folderByIssue.delete(issueKey);

    for (const folder of document.querySelectorAll(
      "zen-folder"
    )) {
      if (!folder.isZenFolder) continue;

      if (
        folder.getAttribute("data-jira-folder") ===
          "true" &&
        folder.getAttribute("data-jira-issue") ===
          issueKey
      ) {
        managedFolders.add(folder);
        folderByIssue.set(issueKey, folder);

        return folder;
      }
    }

    return null;
  }

  function createFolder(tab, issueKey) {
    if (
      typeof gZenFolders === "undefined" ||
      !gZenFolders ||
      !tab
    ) {
      return null;
    }

    const summary = getSummary(tab);

    const label = summary
      ? `${issueKey} ${summary}`
      : issueKey;

    try {
      const folder = gZenFolders.createFolder(
        [tab],
        {
          label: label,
          renameFolder: false,
          saveOnWindowClose: false
        }
      );

      if (!folder) {
        return null;
      }

      folder.setAttribute(
        "data-jira-folder",
        "true"
      );

      folder.setAttribute(
        "data-jira-issue",
        issueKey
      );

      managedFolders.add(folder);
      folderByIssue.set(issueKey, folder);

      updateFolderNameWhenReady(
        tab,
        folder,
        issueKey
      );

      return folder;
    } catch (error) {
      console.error(
        "[Jira Folder Sorter] createFolder failed:",
        error
      );

      return null;
    }
  }

  function updateFolderNameWhenReady(
    tab,
    folder,
    issueKey
  ) {
    let attempts = 0;

    const update = () => {
      if (
        !tab?.isConnected ||
        !folder?.isConnected
      ) {
        return;
      }

      const summary = getSummary(tab);

      if (summary) {
        folder.label =
          `${issueKey} ${summary}`;
        return;
      }

      attempts++;

      if (attempts < 40) {
        setTimeout(update, 500);
      }
    };

    update();
  }

  function moveToFolder(tab, folder) {
    if (
      !tab ||
      !folder ||
      !folder.isZenFolder
    ) {
      return;
    }

    if (tab.group === folder) {
      return;
    }

    try {
      folder.addTabs([tab]);
    } catch (error) {
      console.error(
        "[Jira Folder Sorter] addTabs failed:",
        error
      );
    }
  }

  function processTab(tab) {
    if (!tab || !isEnabled()) {
      return;
    }

    if (!isJiraTab(tab)) {
      return;
    }

    const issueKey = getIssueKey(
      getTabUrl(tab)
    );

    if (!issueKey) {
      return;
    }

    /*
     * First priority:
     * If this tab was opened from a tab already inside
     * one of our Jira folders, reuse that folder.
     */
    const parentFolder =
      findParentFolder(tab);

    if (parentFolder) {
      moveToFolder(tab, parentFolder);
      return;
    }

    /*
     * Second priority:
     * Reuse an existing folder for the same issue.
     */
    const existingFolder =
      findManagedFolder(issueKey);

    if (existingFolder) {
      moveToFolder(tab, existingFolder);
      return;
    }

    /*
     * Otherwise create a brand-new Jira folder.
     */
    createFolder(tab, issueKey);
  }

  function cleanupFolder(folder) {
    if (
      !folder ||
      !folder.isConnected ||
      !managedFolders.has(folder)
    ) {
      return;
    }

    const tabs = Array.from(
      folder.tabs || []
    );

    const realTabs = tabs.filter(tab => {
      return !tab.hasAttribute(
        "zen-empty-tab"
      );
    });

    if (realTabs.length > 0) {
      return;
    }

    const issueKey =
      folder.getAttribute(
        "data-jira-issue"
      );

    if (issueKey) {
      folderByIssue.delete(issueKey);
    }

    managedFolders.delete(folder);

    try {
      folder.delete();
    } catch (error) {
      console.error(
        "[Jira Folder Sorter] folder.delete failed:",
        error
      );
    }
  }

  function onTabOpen(event) {
    const tab = event.target;

    setTimeout(() => {
      processTab(tab);
    }, 500);
  }

  function onTabSelect(event) {
    const tab = event.target;

    setTimeout(() => {
      processTab(tab);
    }, 300);
  }

  function onTabClose(event) {
    const tab = event.target;

    let folder = null;

    try {
      folder = tab.group;
    } catch {}

    if (
      !folder ||
      !folder.isZenFolder ||
      !managedFolders.has(folder)
    ) {
      return;
    }

    setTimeout(() => {
      cleanupFolder(folder);
    }, 100);
  }

  function onLocationChange(event) {
    const browser = event.target;

    if (!browser) return;

    const tab =
      gBrowser.getTabForBrowser(browser);

    if (!tab) return;

    setTimeout(() => {
      processTab(tab);
    }, 500);
  }

  function init() {
    if (
      typeof gBrowser === "undefined" ||
      !gBrowser
    ) {
      return;
    }

    if (
      gBrowser.tabContainer.__jiraFolderSorterLoaded
    ) {
      return;
    }

    gBrowser.tabContainer.__jiraFolderSorterLoaded =
      true;

    console.log(
      "[Jira Folder Sorter] initialized"
    );

    gBrowser.tabContainer.addEventListener(
      "TabOpen",
      onTabOpen
    );

    gBrowser.tabContainer.addEventListener(
      "TabSelect",
      onTabSelect
    );

    gBrowser.tabContainer.addEventListener(
      "TabClose",
      onTabClose
    );

    gBrowser.addEventListener(
      "DOMWindowCreated",
      () => {},
      true
    );

    for (const tab of gBrowser.tabs) {
      setTimeout(() => {
        processTab(tab);
      }, 1000);
    }
  }

  if (
    typeof gBrowserInit !== "undefined" &&
    gBrowserInit.delayedStartupFinished
  ) {
    init();
  } else {
    window.addEventListener(
      "browser-delayed-startup-finished",
      () => {
        init();
      },
      { once: true }
    );
  }
})();
