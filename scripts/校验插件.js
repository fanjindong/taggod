const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const rootDir = path.resolve(__dirname, '..');
const requiredFiles = [
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'README.md',
  'assets/logo.png',
  'assets/icons/icon-source.png',
  'assets/icons/icon-16.png',
  'assets/icons/icon-32.png',
  'assets/icons/icon-48.png',
  'assets/icons/icon-128.png'
];

for (const file of requiredFiles) {
  const filePath = path.join(rootDir, file);

  if (!fs.existsSync(filePath)) {
    throw new Error(`缺少必要文件：${file}`);
  }
}

const manifestPath = path.join(rootDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (manifest.manifest_version !== 3) {
  throw new Error('manifest.json 必须使用 Manifest V3');
}

if (!manifest.permissions.includes('tabs') || !manifest.permissions.includes('tabGroups') || !manifest.permissions.includes('storage')) {
  throw new Error('manifest.json 缺少必要权限');
}

if (!manifest.icons || !manifest.action || !manifest.action.default_icon) {
  throw new Error('manifest.json 必须声明插件图标');
}

for (const scriptFile of ['background.js', 'popup.js']) {
  const scriptPath = path.join(rootDir, scriptFile);
  const scriptContent = fs.readFileSync(scriptPath, 'utf8');

  // 使用 vm.Script 只做语法解析，不执行浏览器专属 API，避免在 Node 环境误触发逻辑。
  new vm.Script(scriptContent, { filename: scriptFile });
}

const backgroundPath = path.join(rootDir, 'background.js');
const backgroundContent = fs.readFileSync(backgroundPath, 'utf8');
const backgroundSandbox = {
  URL,
  chrome: {
    runtime: {
      onMessage: {
        addListener() {}
      }
    },
    commands: {
      onCommand: {
        addListener() {}
      }
    }
  }
};

vm.createContext(backgroundSandbox);
vm.runInContext(backgroundContent, backgroundSandbox, { filename: 'background.js' });

// 主域名归并是核心分组契约，校验脚本覆盖它可以避免后续改动退回完整域名分组。
assert.strictEqual(backgroundSandbox.getDomainKey('https://mail.google.com/inbox'), 'google.com');
assert.strictEqual(backgroundSandbox.getDomainKey('https://docs.google.com/document'), 'google.com');
assert.strictEqual(backgroundSandbox.getDomainKey('https://a.example.com.cn/path'), 'example.com.cn');
assert.strictEqual(backgroundSandbox.getDomainKey('http://localhost:3000'), 'localhost');
assert.strictEqual(backgroundSandbox.getDomainKey('http://127.0.0.1:8080'), '127.0.0.1');
assert.strictEqual(backgroundSandbox.getDomainKey('不是有效网址'), '其他');
assert.strictEqual(backgroundSandbox.getHostnameKey('https://mail.google.com/inbox'), 'mail.google.com');
assert.strictEqual(backgroundSandbox.getHostnameKey('不是有效网址'), '其他');

assert.strictEqual(backgroundSandbox.normalizeSettings({}).minTabsPerGroup, 2);
assert.strictEqual(backgroundSandbox.normalizeSettings({ minTabsPerGroup: 3 }).minTabsPerGroup, 3);
assert.strictEqual(backgroundSandbox.normalizeSettings({ minTabsPerGroup: 0 }).minTabsPerGroup, 2);
assert.strictEqual(backgroundSandbox.normalizeSettings({ minTabsPerGroup: 1 }).minTabsPerGroup, 1);
assert.strictEqual(backgroundSandbox.normalizeSettings({ minTabsPerGroup: 2.5 }).minTabsPerGroup, 2);
assert.strictEqual(backgroundSandbox.normalizeSettings({ minTabsPerGroup: '3' }).minTabsPerGroup, 2);
assert.strictEqual(backgroundSandbox.shouldCreateNativeGroup([1, 2], { minTabsPerGroup: 2 }), true);
assert.strictEqual(backgroundSandbox.shouldCreateNativeGroup([1, 2], { minTabsPerGroup: 3 }), false);
assert.strictEqual(backgroundSandbox.shouldCreateNativeGroup([1], { minTabsPerGroup: 1 }), true);
assert.strictEqual(backgroundSandbox.getShortGroupTitle('google.com'), 'google');
assert.strictEqual(backgroundSandbox.getShortGroupTitle('example.com.cn'), 'example');
assert.strictEqual(backgroundSandbox.getShortGroupTitle('localhost'), 'localhost');
assert.strictEqual(backgroundSandbox.getShortGroupTitle('127.0.0.1'), '127.0.0.1');
assert.strictEqual(backgroundSandbox.getShortGroupTitle('其他'), '其他');

const conflictTitleMap = backgroundSandbox.buildGroupTitleMap(['foo.com', 'foo.net', 'google.com']);
assert.strictEqual(conflictTitleMap.get('foo.com'), 'foo.com');
assert.strictEqual(conflictTitleMap.get('foo.net'), 'foo.net');
assert.strictEqual(conflictTitleMap.get('google.com'), 'google');

const titledTabSnapshots = backgroundSandbox.buildTabSnapshots([
  { id: 101, title: '邮箱', url: 'https://mail.google.com/inbox', active: false, pinned: false, index: 0 },
  { id: 102, title: '站点一', url: 'https://foo.com', active: false, pinned: false, index: 1 },
  { id: 103, title: '站点二', url: 'https://foo.net', active: false, pinned: false, index: 2 }
]);
assert.deepStrictEqual(Array.from(titledTabSnapshots, (tab) => tab.groupTitle), ['google', 'foo.com', 'foo.net']);

const visibleGroupSummaries = backgroundSandbox.buildGroupSummaries([
  { id: 201, url: 'https://mail.google.com/inbox', pinned: false, index: 0 },
  { id: 202, url: 'https://docs.google.com/document', pinned: false, index: 1 },
  { id: 203, url: 'https://solo.example.com', pinned: false, index: 2 },
  { id: 204, url: 'https://pinned.example.net', pinned: true, index: 3 }
], { minTabsPerGroup: 2, priorityGroups: [] });
assert.deepStrictEqual(Array.from(visibleGroupSummaries, (group) => group.groupKey), ['google.com']);
assert.strictEqual(visibleGroupSummaries[0].title, 'google');

const samePrimaryDomainUrls = [
  'https://mail.google.com/inbox',
  'https://docs.google.com/document',
  'https://calendar.google.com/calendar'
];
const sortedSamePrimaryDomainUrls = [...samePrimaryDomainUrls].sort((left, right) => {
  const leftHostname = backgroundSandbox.getHostnameKey(left);
  const rightHostname = backgroundSandbox.getHostnameKey(right);

  // 同一主域名内按完整子域名排序，能让一个网站的不同产品稳定排列。
  return leftHostname.localeCompare(rightHostname, 'zh-CN');
});

assert.deepStrictEqual(sortedSamePrimaryDomainUrls, [
  'https://calendar.google.com/calendar',
  'https://docs.google.com/document',
  'https://mail.google.com/inbox'
]);

const duplicateTabs = [
  { id: 1, title: '文章', url: 'https://example.com/a?utm_source=news&x=1', active: false, pinned: false, index: 0 },
  { id: 2, title: '文章副本', url: 'https://example.com/a?x=1&utm_medium=email', active: true, pinned: false, index: 1 },
  { id: 3, title: '文章固定', url: 'https://example.com/a?x=1&utm_campaign=spring', active: false, pinned: true, index: 2 },
  { id: 4, title: '不同锚点', url: 'https://example.com/a?x=1#section', active: false, pinned: false, index: 3 }
];

assert.strictEqual(
  backgroundSandbox.normalizeUrlForDuplicate('https://example.com/a?utm_source=news&x=1'),
  'https://example.com/a?x=1'
);
assert.strictEqual(
  backgroundSandbox.normalizeUrlForDuplicate('https://example.com/a?x=1#section'),
  'https://example.com/a?x=1#section'
);

const duplicateGroups = backgroundSandbox.buildDuplicateGroups(duplicateTabs);
assert.strictEqual(duplicateGroups.length, 1);
assert.strictEqual(duplicateGroups[0].reason, '忽略追踪参数后重复');
assert.strictEqual(duplicateGroups[0].keepTabId, 3);
// vm 沙箱返回的数组原型不同，转成本上下文数组后再比较内容，避免误判业务结果。
assert.deepStrictEqual(Array.from(duplicateGroups[0].closeTabIds), [1, 2]);

const exactDuplicateGroups = backgroundSandbox.buildDuplicateGroups([
  { id: 10, title: '同页', url: 'https://example.com/same', active: false, pinned: false, index: 2 },
  { id: 11, title: '同页', url: 'https://example.com/same', active: false, pinned: false, index: 1 }
]);
assert.strictEqual(exactDuplicateGroups[0].reason, '完整网址重复');
assert.strictEqual(exactDuplicateGroups[0].keepTabId, 11);

const workspaceItems = backgroundSandbox.sortWorkspaces([
  { id: 'a', name: '旧收藏', createdAt: 1, favorite: true, favoritedAt: 10, tabs: [], groups: [] },
  { id: 'b', name: '新普通', createdAt: 20, favorite: false, tabs: [], groups: [] },
  { id: 'c', name: '新收藏', createdAt: 5, favorite: true, favoritedAt: 30, tabs: [], groups: [] }
]);
// 工作集列表来自后台沙箱，显式转数组可以让断言只关注排序契约。
assert.deepStrictEqual(Array.from(workspaceItems, (item) => item.id), ['c', 'a', 'b']);

const oldWorkspace = backgroundSandbox.normalizeWorkspace({
  id: 'session-1',
  name: '旧会话',
  createdAt: 1,
  tabs: [],
  groups: []
});
assert.strictEqual(oldWorkspace.favorite, false);
assert.strictEqual(oldWorkspace.favoritedAt, 0);
assert.strictEqual(oldWorkspace.updatedAt, 1);

const popupHtml = fs.readFileSync(path.join(rootDir, 'popup.html'), 'utf8');
const readmeContent = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');

// 弹窗和说明文档必须同时展示核心中文文案，避免功能已实现但入口或文档仍停留在旧“会话”命名。
assert.ok(popupHtml.includes('智能去重'));
assert.ok(popupHtml.includes('保存工作集'));
assert.ok(popupHtml.includes('工作集'));
assert.ok(popupHtml.includes('minTabsPerGroupInput'));
assert.ok(popupHtml.includes('分组阈值'));
assert.ok(readmeContent.includes('智能去重'));
assert.ok(readmeContent.includes('保存工作集'));
assert.ok(readmeContent.includes('工作集'));
assert.ok(readmeContent.includes('分组阈值'));
assert.ok(readmeContent.includes('分组显示名'));
assert.ok(readmeContent.includes('重新梳理当前窗口分组'));

async function runAsyncChecks() {
  const groupOperations = {
    grouped: [],
    ungrouped: [],
    updated: []
  };

  backgroundSandbox.queryCurrentWindowTabs = async () => [
    { id: 21, url: 'https://mail.google.com/inbox', pinned: false, groupId: 1 },
    { id: 22, url: 'https://docs.google.com/document', pinned: false, groupId: 1 },
    { id: 23, url: 'https://calendar.google.com/calendar', pinned: false, groupId: 1 },
    { id: 31, url: 'https://a.example.com', pinned: false, groupId: 2 },
    { id: 41, url: 'https://solo.test.com', pinned: false, groupId: 3 },
    { id: 51, url: 'https://pinned.test.com', pinned: true, groupId: 4 }
  ];
  backgroundSandbox.chrome.tabs = {
    group: async ({ tabIds }) => {
      groupOperations.grouped.push(Array.from(tabIds));
      return groupOperations.grouped.length;
    },
    ungroup: async (tabIds) => {
      groupOperations.ungrouped.push(Array.from(tabIds));
    }
  };
  backgroundSandbox.chrome.tabGroups = {
    update: async (groupId, options) => {
      groupOperations.updated.push({ groupId, options });
    }
  };

  await backgroundSandbox.reconcileCurrentWindowGroups({ minTabsPerGroup: 3 });
  assert.deepStrictEqual(groupOperations.grouped, [[21, 22, 23]]);
  assert.deepStrictEqual(groupOperations.ungrouped, [[31], [41]]);
  assert.strictEqual(groupOperations.updated[0].options.title, 'google');
}

runAsyncChecks()
  .then(() => {
    console.log('插件文件校验通过');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
