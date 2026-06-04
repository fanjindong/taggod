const STORAGE_KEYS = {
  sessions: 'tabgod.sessions',
  settings: 'tabgod.settings'
};

const DEFAULT_SETTINGS = {
  // 限制保存数量是为了避免本地存储无限增长，同时保留最近的工作现场。
  maxSessionCount: 10,
  organizeWithGroups: true,
  duplicateKeepStrategy: 'active-or-left',
  priorityGroups: []
};

const GROUP_COLORS = ['blue', 'green', 'yellow', 'red', 'purple', 'cyan', 'orange', 'pink', 'grey'];

// 浏览器没有内置可注册主域名 API，这里保留常见多级公共后缀，避免把站点错误合并到公共后缀本身。
const COMMON_MULTI_PART_PUBLIC_SUFFIXES = new Set([
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'co.uk',
  'org.uk',
  'ac.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.jp',
  'ne.jp',
  'or.jp',
  'co.kr',
  'or.kr',
  'com.br',
  'com.mx',
  'com.sg',
  'com.hk',
  'com.tw'
]);

const TRACKING_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'ref',
  'fbclid',
  'gclid'
]);

function normalizeUrlForDuplicate(url) {
  try {
    const parsedUrl = new URL(url);

    TRACKING_QUERY_PARAMS.forEach((paramName) => {
      // 只移除明确的追踪参数，避免把业务查询参数误当成重复依据。
      parsedUrl.searchParams.delete(paramName);
    });

    return parsedUrl.toString();
  } catch (error) {
    // 异常网址不能安全规范化，保留原值可以避免把内部页面错误合并。
    return String(url || '');
  }
}

function isIpAddressHost(hostname) {
  // IP 地址没有可注册主域名，保持原值可以避免把不同内网服务错误合并。
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}

function getPrimaryDomainFromHostname(hostname) {
  const normalizedHostname = String(hostname || '').toLowerCase().replace(/\.$/, '');

  if (!normalizedHostname) {
    return '其他';
  }

  if (isIpAddressHost(normalizedHostname)) {
    return normalizedHostname;
  }

  const parts = normalizedHostname.split('.').filter(Boolean);

  if (parts.length <= 2) {
    // 短主机名和二段域名本身已经是最稳定的分组键，不需要继续裁剪。
    return normalizedHostname;
  }

  const publicSuffix = parts.slice(-2).join('.');

  if (COMMON_MULTI_PART_PUBLIC_SUFFIXES.has(publicSuffix) && parts.length >= 3) {
    // 多级公共后缀需要保留注册名，否则 example.com.cn 会被错误合并为 com.cn。
    return parts.slice(-3).join('.');
  }

  return parts.slice(-2).join('.');
}

function getDomainKey(url) {
  try {
    const parsedUrl = new URL(url);
    return getPrimaryDomainFromHostname(parsedUrl.hostname);
  } catch (error) {
    // 无法解析的网址通常来自浏览器内部页面，归入“其他”能避免整理流程中断。
    return '其他';
  }
}

function getHostnameKey(url) {
  try {
    const parsedUrl = new URL(url);
    return String(parsedUrl.hostname || '其他').toLowerCase().replace(/\.$/, '');
  } catch (error) {
    // 异常网址没有可靠子域名，使用“其他”可以让它们在主域名兜底组内稳定排序。
    return '其他';
  }
}

function getGroupColor(index) {
  // Chrome 原生分组颜色数量有限，循环使用可以保证任意数量主域名都有稳定颜色。
  return GROUP_COLORS[index % GROUP_COLORS.length];
}

function normalizeSettings(settings) {
  const normalized = Object.assign({}, DEFAULT_SETTINGS, settings || {});

  if (!Array.isArray(normalized.priorityGroups)) {
    // 旧版本没有该字段，兜底为空数组可以兼容已经安装过的用户配置。
    normalized.priorityGroups = [];
  }

  return normalized;
}

function normalizeWorkspace(workspace) {
  const createdAt = Number(workspace && workspace.createdAt) || Date.now();

  return Object.assign({}, workspace, {
    id: workspace && workspace.id ? workspace.id : `session-${createdAt}`,
    name: workspace && workspace.name ? workspace.name : `${formatDateTime(createdAt)} 的工作集`,
    createdAt,
    updatedAt: Number(workspace && workspace.updatedAt) || createdAt,
    favorite: Boolean(workspace && workspace.favorite),
    favoritedAt: Number(workspace && workspace.favoritedAt) || 0,
    activeUrl: workspace && workspace.activeUrl ? workspace.activeUrl : '',
    tabs: Array.isArray(workspace && workspace.tabs) ? workspace.tabs : [],
    groups: Array.isArray(workspace && workspace.groups) ? workspace.groups : []
  });
}

function sortWorkspaces(workspaces) {
  return [...workspaces].map(normalizeWorkspace).sort((left, right) => {
    if (left.favorite !== right.favorite) {
      return left.favorite ? -1 : 1;
    }

    if (left.favorite && right.favorite && left.favoritedAt !== right.favoritedAt) {
      return right.favoritedAt - left.favoritedAt;
    }

    return right.createdAt - left.createdAt;
  });
}

function isPriorityGroup(settings, groupKey) {
  return settings.priorityGroups.some((group) => group.groupKey === groupKey);
}

function buildCurrentGroupOrderMap(tabs) {
  const orderMap = new Map();

  tabs.forEach((tab) => {
    if (tab.pinned) {
      return;
    }

    const groupKey = getDomainKey(tab.url || '');

    if (!orderMap.has(groupKey)) {
      // 当前从左到右的首次出现顺序代表用户刚刚手动拖好的分组顺序。
      orderMap.set(groupKey, orderMap.size);
    }
  });

  return orderMap;
}

async function queryCurrentWindowTabs() {
  return chrome.tabs.query({ currentWindow: true });
}

function buildTabSnapshot(tab) {
  const groupKey = getDomainKey(tab.url || '');

  return {
    id: tab.id,
    title: tab.title || '未命名标签',
    url: tab.url || '',
    favIconUrl: tab.favIconUrl || '',
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    index: Number.isInteger(tab.index) ? tab.index : 0,
    groupKey
  };
}

function chooseDuplicateKeepTab(tabs) {
  const sortedTabs = [...tabs].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    if (left.active !== right.active) {
      return left.active ? -1 : 1;
    }

    return left.index - right.index;
  });

  return sortedTabs[0];
}

function buildDuplicateGroups(tabs) {
  const normalizedUrlMap = new Map();

  tabs.forEach((tab) => {
    if (!tab.url || typeof tab.id !== 'number') {
      return;
    }

    const normalizedUrl = normalizeUrlForDuplicate(tab.url);
    const normalizedTabs = normalizedUrlMap.get(normalizedUrl) || [];
    normalizedTabs.push(tab);
    normalizedUrlMap.set(normalizedUrl, normalizedTabs);
  });

  const duplicateGroups = [];

  normalizedUrlMap.forEach((groupTabs, normalizedUrl) => {
    if (groupTabs.length <= 1) {
      return;
    }

    const originalUrlSet = new Set(groupTabs.map((tab) => tab.url || ''));
    const reason = originalUrlSet.size === 1 ? '完整网址重复' : '忽略追踪参数后重复';
    const keepTab = chooseDuplicateKeepTab(groupTabs);
    const closeTabs = groupTabs
      .filter((tab) => tab.id !== keepTab.id)
      .sort((left, right) => left.index - right.index);

    duplicateGroups.push({
      duplicateKey: normalizedUrl,
      reason,
      title: keepTab.title || '未命名标签',
      groupKey: getDomainKey(keepTab.url || ''),
      keepTabId: keepTab.id,
      keepTitle: keepTab.title || '未命名标签',
      keepUrl: keepTab.url || '',
      closeTabIds: closeTabs.map((tab) => tab.id),
      closeCount: closeTabs.length,
      tabCount: groupTabs.length
    });
  });

  return duplicateGroups;
}

function buildOverview(tabs) {
  const domainSet = new Set();
  const groupSet = new Set();

  tabs.forEach((tab) => {
    domainSet.add(getDomainKey(tab.url || ''));

    if (typeof tab.groupId === 'number' && tab.groupId >= 0) {
      groupSet.add(tab.groupId);
    }
  });

  const duplicateCount = buildDuplicateGroups(tabs).reduce((total, group) => {
    return total + group.closeCount;
  }, 0);

  return {
    tabCount: tabs.length,
    domainCount: domainSet.size,
    duplicateCount,
    groupCount: groupSet.size
  };
}

async function getPopupState() {
  const tabs = await queryCurrentWindowTabs();
  const stored = await chrome.storage.local.get([STORAGE_KEYS.sessions, STORAGE_KEYS.settings]);
  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);

  return {
    tabs: tabs.map(buildTabSnapshot),
    groups: buildGroupSummaries(tabs, settings),
    overview: buildOverview(tabs),
    sessions: sortWorkspaces(stored[STORAGE_KEYS.sessions] || []),
    settings
  };
}

async function organizeTabs() {
  const tabs = await queryCurrentWindowTabs();
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
  const currentGroupOrderMap = buildCurrentGroupOrderMap(tabs);

  if (tabs.length === 0) {
    return { organizedCount: 0, groupCount: 0 };
  }

  const sortedTabs = [...tabs].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }

    const leftDomain = getDomainKey(left.url || '');
    const rightDomain = getDomainKey(right.url || '');
    const leftIsPriority = isPriorityGroup(settings, leftDomain);
    const rightIsPriority = isPriorityGroup(settings, rightDomain);

    if (leftIsPriority !== rightIsPriority) {
      return leftIsPriority ? -1 : 1;
    }

    const leftCurrentRank = currentGroupOrderMap.get(leftDomain) ?? Number.POSITIVE_INFINITY;
    const rightCurrentRank = currentGroupOrderMap.get(rightDomain) ?? Number.POSITIVE_INFINITY;

    if (leftCurrentRank !== rightCurrentRank) {
      return leftCurrentRank - rightCurrentRank;
    }

    const domainCompare = leftDomain.localeCompare(rightDomain, 'zh-CN');

    if (domainCompare !== 0) {
      return domainCompare;
    }

    const leftHostname = getHostnameKey(left.url || '');
    const rightHostname = getHostnameKey(right.url || '');
    const hostnameCompare = leftHostname.localeCompare(rightHostname, 'zh-CN');

    return hostnameCompare === 0 ? left.index - right.index : hostnameCompare;
  });

  for (let index = 0; index < sortedTabs.length; index += 1) {
    const tab = sortedTabs[index];

    if (typeof tab.id === 'number') {
      // 逐个移动可以减少跨固定标签区域移动导致的失败，失败标签不会阻断后续整理。
      await chrome.tabs.move(tab.id, { index }).catch(() => undefined);
    }
  }

  const movedTabs = await queryCurrentWindowTabs();
  const groups = new Map();

  movedTabs.forEach((tab) => {
    if (!tab.pinned && typeof tab.id === 'number') {
      const groupKey = getDomainKey(tab.url || '');
      const groupTabs = groups.get(groupKey) || [];
      groupTabs.push(tab.id);
      groups.set(groupKey, groupTabs);
    }
  });

  let groupIndex = 0;

  for (const [groupKey, tabIds] of groups.entries()) {
    if (tabIds.length < 2) {
      // 单个标签创建原生分组会增加标签栏噪音，只对真正聚合了多个标签的主域名建组。
      continue;
    }

    const groupId = await chrome.tabs.group({ tabIds }).catch(() => null);

    if (typeof groupId === 'number') {
      await chrome.tabGroups.update(groupId, {
        title: groupKey,
        color: getGroupColor(groupIndex)
      });
      groupIndex += 1;
    }
  }

  return {
    organizedCount: tabs.length,
    groupCount: groupIndex
  };
}

function buildGroupSummaries(tabs, settings) {
  const groupMap = new Map();
  const currentGroupOrderMap = buildCurrentGroupOrderMap(tabs);

  tabs.forEach((tab) => {
    const groupKey = getDomainKey(tab.url || '');
    const summary = groupMap.get(groupKey) || {
      groupKey,
      title: groupKey,
      tabCount: 0,
      starred: isPriorityGroup(settings, groupKey),
      currentOrder: currentGroupOrderMap.get(groupKey) ?? Number.POSITIVE_INFINITY
    };

    summary.tabCount += 1;
    groupMap.set(groupKey, summary);
  });

  return Array.from(groupMap.values()).sort((left, right) => {
    if (left.starred !== right.starred) {
      return left.starred ? -1 : 1;
    }

    if (left.currentOrder !== right.currentOrder) {
      return left.currentOrder - right.currentOrder;
    }

    return left.groupKey.localeCompare(right.groupKey, 'zh-CN');
  });
}

async function scanDuplicateTabs() {
  const tabs = await queryCurrentWindowTabs();

  return {
    groups: buildDuplicateGroups(tabs)
  };
}

async function closeSelectedDuplicateTabs(tabIds) {
  const safeTabIds = Array.from(new Set(Array.isArray(tabIds) ? tabIds : []))
    .filter((tabId) => Number.isInteger(tabId));

  if (safeTabIds.length === 0) {
    return {
      closedCount: 0,
      failedCount: 0
    };
  }

  try {
    await chrome.tabs.remove(safeTabIds);
    return {
      closedCount: safeTabIds.length,
      failedCount: 0
    };
  } catch (error) {
    // 批量关闭失败时逐个重试，因为用户可能在确认期间手动关闭了部分标签。
    let closedCount = 0;

    for (const tabId of safeTabIds) {
      try {
        await chrome.tabs.remove(tabId);
        closedCount += 1;
      } catch (innerError) {
        // 单个标签失败只影响统计，不应阻断后续可关闭标签的清理。
      }
    }

    return {
      closedCount,
      failedCount: safeTabIds.length - closedCount
    };
  }
}

async function closeDuplicateTabs() {
  const tabs = await queryCurrentWindowTabs();
  const duplicateGroups = buildDuplicateGroups(tabs);
  const tabIdsToClose = duplicateGroups.flatMap((group) => group.closeTabIds);
  const result = await closeSelectedDuplicateTabs(tabIdsToClose);

  return {
    closedCount: result.closedCount,
    failedCount: result.failedCount
  };
}

async function saveWorkspace(name) {
  const tabs = await queryCurrentWindowTabs();
  const stored = await chrome.storage.local.get([STORAGE_KEYS.sessions, STORAGE_KEYS.settings]);
  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
  const existingSessions = sortWorkspaces(stored[STORAGE_KEYS.sessions] || []);
  const createdAt = Date.now();
  const snapshots = tabs.map(buildTabSnapshot);
  const activeTab = snapshots.find((tab) => tab.active);
  const groups = buildGroupSnapshots(snapshots);
  const workspaceName = String(name || '').trim() || `${formatDateTime(createdAt)} 的工作集`;
  const workspace = normalizeWorkspace({
    id: `session-${createdAt}`,
    name: workspaceName,
    createdAt,
    updatedAt: createdAt,
    activeUrl: activeTab ? activeTab.url : '',
    tabs: snapshots,
    groups
  });
  const sessions = [workspace, ...existingSessions].slice(0, settings.maxSessionCount);

  await chrome.storage.local.set({
    [STORAGE_KEYS.sessions]: sessions,
    [STORAGE_KEYS.settings]: settings
  });

  return {
    workspace,
    session: workspace,
    savedCount: snapshots.length,
    savedTabIds: snapshots
      .map((tab) => tab.id)
      .filter((tabId) => Number.isInteger(tabId))
  };
}

async function saveCurrentSession() {
  return saveWorkspace();
}

async function closeSavedTabs(tabIds) {
  const safeTabIds = Array.from(new Set(Array.isArray(tabIds) ? tabIds : []))
    .filter((tabId) => Number.isInteger(tabId));

  if (safeTabIds.length === 0) {
    return {
      closedCount: 0,
      failedCount: 0
    };
  }

  let closedCount = 0;

  for (const tabId of safeTabIds) {
    try {
      await chrome.tabs.remove(tabId);
      closedCount += 1;
    } catch (error) {
      // 保存成功后用户仍可能手动关闭标签，失败项只反馈数量，避免清场中断。
    }
  }

  return {
    closedCount,
    failedCount: safeTabIds.length - closedCount
  };
}

async function togglePriorityGroup(groupKey) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
  const existingIndex = settings.priorityGroups.findIndex((group) => group.groupKey === groupKey);
  let starred = false;

  if (existingIndex >= 0) {
    settings.priorityGroups.splice(existingIndex, 1);
  } else {
    settings.priorityGroups.push({
      groupKey,
      title: groupKey,
      starredAt: Date.now()
    });
    starred = true;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });

  return {
    groupKey,
    starred,
    priorityCount: settings.priorityGroups.length
  };
}

async function updateStoredWorkspaces(updater) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.sessions]);
  const workspaces = sortWorkspaces(stored[STORAGE_KEYS.sessions] || []);
  const nextWorkspaces = updater(workspaces).map(normalizeWorkspace);
  const sortedNextWorkspaces = sortWorkspaces(nextWorkspaces);

  await chrome.storage.local.set({
    [STORAGE_KEYS.sessions]: sortedNextWorkspaces
  });

  return sortedNextWorkspaces;
}

async function renameWorkspace(workspaceId, name) {
  const trimmedName = String(name || '').trim();

  if (!trimmedName) {
    throw new Error('工作集名称不能为空');
  }

  let renamedWorkspace = null;

  await updateStoredWorkspaces((workspaces) => {
    return workspaces.map((workspace) => {
      if (workspace.id !== workspaceId) {
        return workspace;
      }

      renamedWorkspace = normalizeWorkspace(Object.assign({}, workspace, {
        name: trimmedName,
        updatedAt: Date.now()
      }));
      return renamedWorkspace;
    });
  });

  if (!renamedWorkspace) {
    throw new Error('没有找到要重命名的工作集');
  }

  return {
    workspace: renamedWorkspace
  };
}

async function deleteWorkspace(workspaceId) {
  let deletedCount = 0;

  await updateStoredWorkspaces((workspaces) => {
    return workspaces.filter((workspace) => {
      if (workspace.id === workspaceId) {
        deletedCount += 1;
        return false;
      }

      return true;
    });
  });

  if (deletedCount === 0) {
    throw new Error('没有找到要删除的工作集');
  }

  return {
    deletedCount
  };
}

async function toggleWorkspaceFavorite(workspaceId) {
  let updatedWorkspace = null;

  await updateStoredWorkspaces((workspaces) => {
    return workspaces.map((workspace) => {
      if (workspace.id !== workspaceId) {
        return workspace;
      }

      const nextFavorite = !workspace.favorite;
      updatedWorkspace = normalizeWorkspace(Object.assign({}, workspace, {
        favorite: nextFavorite,
        favoritedAt: nextFavorite ? Date.now() : 0,
        updatedAt: Date.now()
      }));
      return updatedWorkspace;
    });
  });

  if (!updatedWorkspace) {
    throw new Error('没有找到要收藏的工作集');
  }

  return {
    workspace: updatedWorkspace,
    favorite: updatedWorkspace.favorite
  };
}

function buildGroupSnapshots(tabs) {
  const groupMap = new Map();

  tabs.forEach((tab) => {
    const groupKey = tab.groupKey || '其他';
    const snapshot = groupMap.get(groupKey) || {
      groupKey,
      title: groupKey,
      color: getGroupColor(groupMap.size),
      tabCount: 0
    };

    snapshot.tabCount += 1;
    groupMap.set(groupKey, snapshot);
  });

  return Array.from(groupMap.values());
}

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

async function restoreSession(sessionId, options = {}) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.sessions]);
  const sessions = sortWorkspaces(stored[STORAGE_KEYS.sessions] || []);
  const session = sessions.find((item) => item.id === sessionId);

  if (!session) {
    throw new Error('没有找到要恢复的工作集');
  }

  const createdTabs = [];
  let failedCount = 0;
  let targetWindowId = null;
  let createdFirstRestorableTab = false;

  if (options.newWindow) {
    const firstRestorableTab = session.tabs.find((tab) => tab.url && !tab.url.startsWith('chrome://'));

    if (!firstRestorableTab) {
      throw new Error('工作集中没有可恢复的页面');
    }

    const createdWindow = await chrome.windows.create({
      url: firstRestorableTab.url,
      focused: true
    });
    targetWindowId = createdWindow.id;
    createdFirstRestorableTab = true;

    if (createdWindow.tabs && createdWindow.tabs[0]) {
      createdTabs.push(Object.assign({}, createdWindow.tabs[0], {
        groupKey: firstRestorableTab.groupKey
      }));
    }
  }

  for (const tab of session.tabs) {
    if (!tab.url || tab.url.startsWith('chrome://')) {
      // Chrome 内部页面通常不允许扩展创建，跳过可以避免恢复流程整体失败。
      failedCount += 1;
      continue;
    }

    if (createdFirstRestorableTab) {
      // 新窗口创建必须先带一个 URL，这个首个页面已经存在，避免重复恢复同一条记录。
      createdFirstRestorableTab = false;
      continue;
    }

    try {
      const createdTab = await chrome.tabs.create({
        url: tab.url,
        active: false,
        pinned: Boolean(tab.pinned),
        windowId: targetWindowId || undefined
      });
      createdTabs.push(Object.assign({}, createdTab, { groupKey: tab.groupKey }));
    } catch (error) {
      failedCount += 1;
    }
  }

  await regroupRestoredTabs(createdTabs);

  const tabToActivate = createdTabs.find((tab) => tab.url === session.activeUrl) || createdTabs[0];

  if (tabToActivate && typeof tabToActivate.id === 'number') {
    await chrome.tabs.update(tabToActivate.id, { active: true });
  }

  return {
    restoredCount: createdTabs.length,
    failedCount
  };
}

async function regroupRestoredTabs(tabs) {
  const groups = new Map();

  tabs.forEach((tab) => {
    if (tab.pinned || typeof tab.id !== 'number') {
      return;
    }

    const groupKey = tab.groupKey || getDomainKey(tab.url || '');
    const groupTabs = groups.get(groupKey) || [];
    groupTabs.push(tab.id);
    groups.set(groupKey, groupTabs);
  });

  let groupIndex = 0;

  for (const [groupKey, tabIds] of groups.entries()) {
    if (tabIds.length < 2) {
      // 恢复工作集时沿用同一规则，避免单标签主域名在恢复后变成多余分组。
      continue;
    }

    const groupId = await chrome.tabs.group({ tabIds }).catch(() => null);

    if (typeof groupId === 'number') {
      await chrome.tabGroups.update(groupId, {
        title: groupKey,
        color: getGroupColor(groupIndex)
      });
      groupIndex += 1;
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : '操作失败'
      });
    });

  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'organize-tabs') {
    organizeTabs().catch(() => undefined);
  }

  if (command === 'save-session') {
    // 快捷键没有前台提示通道，捕获异常可以避免后台服务出现未处理拒绝。
    saveCurrentSession().catch(() => undefined);
  }
});

async function handleMessage(message) {
  const action = message && message.action;

  if (action === 'get-state') {
    return getPopupState();
  }

  if (action === 'organize-tabs') {
    return organizeTabs();
  }

  if (action === 'close-duplicates') {
    return closeDuplicateTabs();
  }

  if (action === 'scan-duplicates') {
    return scanDuplicateTabs();
  }

  if (action === 'close-selected-duplicates') {
    return closeSelectedDuplicateTabs(message.tabIds);
  }

  if (action === 'save-workspace') {
    return saveWorkspace(message.name);
  }

  if (action === 'close-saved-tabs') {
    return closeSavedTabs(message.tabIds);
  }

  if (action === 'restore-workspace') {
    return restoreSession(message.workspaceId || message.sessionId);
  }

  if (action === 'restore-workspace-new-window') {
    return restoreSession(message.workspaceId || message.sessionId, { newWindow: true });
  }

  if (action === 'rename-workspace') {
    return renameWorkspace(message.workspaceId, message.name);
  }

  if (action === 'delete-workspace') {
    return deleteWorkspace(message.workspaceId);
  }

  if (action === 'toggle-workspace-favorite') {
    return toggleWorkspaceFavorite(message.workspaceId);
  }

  if (action === 'save-session') {
    return saveWorkspace(message.name);
  }

  if (action === 'restore-session') {
    return restoreSession(message.sessionId);
  }

  if (action === 'toggle-priority-group') {
    return togglePriorityGroup(message.groupKey);
  }

  if (action === 'activate-tab') {
    await chrome.tabs.update(message.tabId, { active: true });
    return { activated: true };
  }

  if (action === 'close-tab') {
    await chrome.tabs.remove(message.tabId);
    return { closed: true };
  }

  throw new Error('未知操作');
}
