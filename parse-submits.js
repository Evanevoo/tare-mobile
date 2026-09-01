const fs = require('fs');
const raw = fs.readFileSync('eas-submits2.json', 'utf8');
const start = raw.indexOf('[');
const data = JSON.parse(raw.slice(start));
const rows = data.map(s => ({
  platform: s.platform,
  status: s.status,
  appVersion: s.appBuildVersion || (s.build && s.build.appBuildVersion),
  createdAt: s.createdAt,
  id: s.id,
}));
fs.writeFileSync('submits-summary.json', JSON.stringify(rows, null, 2));
console.log('total', rows.length);
console.log('android', rows.filter(r => r.platform === 'ANDROID').length);
