// ==UserScript==
	
// @name        Jira Folder Sorter
	
// @description Automatically organizes Jira tabs into native Zen folders.
	
// @version     1.3.0
	
// ==/UserScript==
	

(function () {
  "use strict";

  const PREF_ENABLED = "extensions.jira-folder-sorter.enabled";
  const PREF_BASE_URL = "extensions.jira-folder-sorter.jira-base-url";

  const folderByIssue = new Map();
  const managedFolders = new Set();

  function isEnabled() {
    try {
      return Services.prefs.getBoolPref(PREF_ENABLED, true);
    } catch {
      return true;
    }
  }

  function getBaseUrl() {
    try {
      return Services.prefs.getCharPref(PREF_BASE_URL, "").replace(/\/+$/, "");
    } catch {
      return "";
    }
  }

  function isJiraUrl(url) {
    const base = getBaseUrl();
    return !!(base && url && url.startsWith(base + "/browse/"));
  }

  function getIssueKey(url) {
    if (!url) return null;

    const match = url.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i);
    return match ? match[1].toUpperCase() : null;
  }

  function getIssueSummary(tab) {
    if (!tab) return null;

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

    const key = getIssueKey(tab.linkedBrowser?.currentURI?.spec);

    if (key) {
      title = title.replace(
        new RegExp("^" + key + "\\s*[-|:]?\\s*", "i"),
        ""
      );
    }

    if (!title || /^Jira$/i.test(title)) {
      return null;
    }

    return title;
  }

  function getTabUrl(tab) {
    try {
      return (
        tab.linkedBrowser?.currentURI?.spec ||
        tab.linkedBrowser?.currentURI?.asciiSpec ||
        ""
      );
    } catch {
      return "";
    }
  }

  function getFolderForTab(tab) {
    if (!tab) return null;

    const group = tab.group;

    return group?.isZenFolder ? group : null;
  }

  function findOpenerFolder(tab) {
    const visited = new Set();
    let current = tab;

    while (current) {
      if (visited.has(current)) break;

      visited.add(current);

      const folder = getFolderForTab(current);

      if (folder && managedFolders.has(folder)) {
        return folder;
      }

      current = current.openerTab || current.ownerTab || null;
    }

    return null;
  }

  function findExistingIssueFolder(issueKey) {
    if (!issueKey) return null;

    const cached = folderByIssue.get(issueKey);

    if (cached?.isConnected && cached.isZenFolder) {
      return cached;
    }

    folderByIssue.delete(issueKey);

    for (const folder of document.querySelectorAll("zen-folder")) {
      if (!folder.isZenFolder) continue;

      if (folder.getAttribute("data-jira-issue") === issueKey) {
        folderByIssue.set(issueKey, folder);
        managedFolders.add(folder);
        return folder;
      }
    }

    return null;
  }

  function createJiraFolder(tab, issueKey) {
    if (!gZenFolders || !tab) return null;

    const summary = getIssueSummary(tab);
    const label = summary ? `${issueKey} ${summary}` : issueKey;

    const folder = gZenFolders.createFolder([tab], {
      label,
      renameFolder: false,
      saveOnWindowClose: false,
    });

    if (!folder) return null;

    folder.setAttribute("data-jira-folder", "true");
    folder.setAttribute("data-jira-issue", issueKey);

    managedFolders.add(folder);
    folderByIssue.set(issueKey, folder);

    return folder;
  }

  function moveIntoFolder(tab, folder) {
    if (!tab || !folder || !folder.isZenFolder) return;

    if (tab.group === folder) return;

    folder.addTabs([tab]);
  }

  function processTab(tab) {
    if (!isEnabled() || !tab) return;

    const url = getTabUrl(tab);

    if (!isJiraUrl(url)) return;

    const issueKey = getIssueKey(url);

    if (!issueKey) return;

    const openerFolder = findOpenerFolder(tab);

    if (openerFolder) {
      moveIntoFolder(tab, openerFolder);
      return;
    }

    const existingFolder = findExistingIssueFolder(issueKey);

    if (existingFolder) {
      moveIntoFolder(tab, existingFolder);
      return;
    }

    const folder = createJiraFolder(tab, issueKey);

    if (!folder) return;

    waitForJiraTitle(tab, folder, issueKey);
  }

  function waitForJiraTitle(tab, folder, issueKey) {
    let attempts = 0;

    const update = () => {
      if (!folder?.isConnected || !tab?.isConnected) return;

      const summary = getIssueSummary(tab);

      if (summary) {
        folder.label = `${issueKey} ${summary}`;
        return;
      }

      attempts++;

      if (attempts < 30) {
        setTimeout(update, 500);
      }
    };

    update();
  }

  function cleanupEmptyFolder(folder) {
    if (!folder || !folder.isConnected) return;
    if (!managedFolders.has(folder)) return;

    const realTabs = folder.tabs.filter(
      tab => !tab.hasAttribute("zen-empty-tab")
    );

    if (realTabs.length === 0) {
      const issueKey = folder.getAttribute("data-jira-issue");

      if (issueKey) {
        folderByIssue.delete(issueKey);
      }

      managedFolders.delete(folder);

      try {
        folder.delete();
      } catch (error) {
        console.error(
          "[Jira Folder Sorter] Failed to delete folder:",
          error
        );
      }
    }
  }

  function onTabClose(event) {
    const tab = event.target;
    const folder = tab?.group;

    if (!folder?.isZenFolder) return;
    if (!managedFolders.has(folder)) return;

    setTimeout(() => {
      cleanupEmptyFolder(folder);
    }, 0);
  }

  function onTabOpen(event) {
    const tab = event.target;

    setTimeout(() => {
      processTab(tab);
    }, 100);
  }

  function onTabSelect(event) {
    const tab = event.target;

    if (tab?.linkedBrowser?.currentURI?.spec) {
      setTimeout(() => {
        processTab(tab);
      }, 100);
    }
  }

  function onDOMContentLoaded(event) {
    const browser = event.target;

    if (!browser || browser !== gBrowser.selectedBrowser) {
      return;
    }

    const tab = gBrowser.getTabForBrowser(browser);

    if (!tab) return;

    setTimeout(() => {
      processTab(tab);
    }, 100);
  }

  function init() {
    if (!gBrowser) return;

    console.log("[Jira Folder Sorter] initialized");

    gBrowser.tabContainer.addEventListener("TabOpen", onTabOpen);
    gBrowser.tabContainer.addEventListener("TabClose", onTabClose);
    gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);

    gBrowser.addEventListener(
      "DOMContentLoaded",
      onDOMContentLoaded,
      true
    );

    for (const tab of gBrowser.tabs) {
      setTimeout(() => processTab(tab), 500);
    }
  }

  if (gBrowserInit?.delayedStartupFinished) {
    init();
  } else {
    window.addEventListener(
      "browser-delayed-startup-finished",
      () => init(),
      { once: true }
    );
  }
})();
