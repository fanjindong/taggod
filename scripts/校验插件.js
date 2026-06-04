const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootDir = path.resolve(__dirname, '..');
const requiredFiles = [
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'README.md'
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

for (const scriptFile of ['background.js', 'popup.js']) {
  const scriptPath = path.join(rootDir, scriptFile);
  const scriptContent = fs.readFileSync(scriptPath, 'utf8');

  // 使用 vm.Script 只做语法解析，不执行浏览器专属 API，避免在 Node 环境误触发逻辑。
  new vm.Script(scriptContent, { filename: scriptFile });
}

console.log('插件文件校验通过');
