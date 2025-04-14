
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../node_modules/@solid-primitives/map/dist/index.cjs');

try {
  if (fs.existsSync(filePath)) {
    console.log('Patching @solid-primitives/map to use dynamic import');
    let content = fs.readFileSync(filePath, 'utf8');
    content = content.replace(
      "var trigger = require('@solid-primitives/trigger');",
      "var trigger = {}; import('@solid-primitives/trigger').then(mod => Object.assign(trigger, mod));"
    );
    fs.writeFileSync(filePath, content);
    console.log('Patched successfully!');
  }
} catch (error) {
  console.error('Error patching file:', error);
}
