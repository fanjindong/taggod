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

console.log('插件文件校验通过');
