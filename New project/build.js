const fs = require('node:fs');
const path = require('node:path');

const destination = path.join(__dirname, 'public');
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'index.html'), path.join(destination, 'index.html'));
fs.copyFileSync(path.join(__dirname, 'app.js'), path.join(destination, 'app.js'));
for (const file of ['manifest.webmanifest', 'service-worker.js', 'app-icon.png']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(destination, file));
}
