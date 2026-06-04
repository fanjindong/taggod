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

function buildOverview(tabs) {
  const domainSet = new Set();
  const urlCounter = new Map();
  const groupSet = new Set();

  tabs.forEach((tab) => {
    domainSet.add(getDomainKey(tab.url || ''));

    if (tab.url) {
      urlCounter.set(tab.url, (urlCounter.get(tab.url) || 0) + 1);
    }

    if (typeof tab.groupId === 'number' && tab.groupId >= 0) {
      groupSet.add(tab.groupId);
    }
  });

  const duplicateCount = Array.from(urlCounter.values()).reduce((total, count) => {
    return count > 1 ? total + count - 1 : total;
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
    sessions: stored[STORAGE_KEYS.sessions] || [],
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

async function closeDuplicateTabs() {
  const tabs = await queryCurrentWindowTabs();
  const tabsByUrl = new Map();

  tabs.forEach((tab) => {
    if (!tab.url || typeof tab.id !== 'number') {
      return;
    }

    const sameUrlTabs = tabsByUrl.get(tab.url) || [];
    sameUrlTabs.push(tab);
    tabsByUrl.set(tab.url, sameUrlTabs);
  });

  const tabIdsToClose = [];

  tabsByUrl.forEach((sameUrlTabs) => {
    if (sameUrlTabs.length <= 1) {
      return;
    }

    const activeTab = sameUrlTabs.find((tab) => tab.active);
    const tabToKeep = activeTab || sameUrlTabs.sort((left, right) => left.index - right.index)[0];

    sameUrlTabs.forEach((tab) => {
      if (tab.id !== tabToKeep.id && typeof tab.id === 'number') {
        tabIdsToClose.push(tab.id);
      }
    });
  });

  if (tabIdsToClose.length > 0) {
    await chrome.tabs.remove(tabIdsToClose);
  }

  return { closedCount: tabIdsToClose.length };
}

async function saveCurrentSession() {
  const tabs = await queryCurrentWindowTabs();
  const stored = await chrome.storage.local.get([STORAGE_KEYS.sessions, STORAGE_KEYS.settings]);
  const settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
  const existingSessions = stored[STORAGE_KEYS.sessions] || [];
  const createdAt = Date.now();
  const snapshots = tabs.map(buildTabSnapshot);
  const activeTab = snapshots.find((tab) => tab.active);
  const groups = buildGroupSnapshots(snapshots);
  const session = {
    id: `session-${createdAt}`,
    name: `${formatDateTime(createdAt)} 保存的会话`,
    createdAt,
    activeUrl: activeTab ? activeTab.url : '',
    tabs: snapshots,
    groups
  };
  const sessions = [session, ...existingSessions].slice(0, settings.maxSessionCount);

  await chrome.storage.local.set({
    [STORAGE_KEYS.sessions]: sessions,
    [STORAGE_KEYS.settings]: settings
  });

  return {
    session,
    savedCount: snapshots.length
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

async function restoreSession(sessionId) {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.sessions]);
  const sessions = stored[STORAGE_KEYS.sessions] || [];
  const session = sessions.find((item) => item.id === sessionId);

  if (!session) {
    throw new Error('没有找到要恢复的会话');
  }

  const createdTabs = [];
  let failedCount = 0;

  for (const tab of session.tabs) {
    if (!tab.url || tab.url.startsWith('chrome://')) {
      // Chrome 内部页面通常不允许扩展创建，跳过可以避免恢复流程整体失败。
      failedCount += 1;
      continue;
    }

    try {
      const createdTab = await chrome.tabs.create({
        url: tab.url,
        active: false,
        pinned: Boolean(tab.pinned)
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
      // 恢复会话时沿用同一规则，避免单标签主域名在恢复后变成多余分组。
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

  if (action === 'save-session') {
    return saveCurrentSession();
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
