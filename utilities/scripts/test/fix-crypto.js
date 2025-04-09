import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filePath = path.join(__dirname, 'server', 'bot', 'bridge.ts');
const fileContent = fs.readFileSync(filePath, 'utf8');

// Replace require('crypto') with crypto
const newContent = fileContent.replace(/require\('crypto'\)/g, 'crypto');

fs.writeFileSync(filePath, newContent);
console.log('Replaced require(\'crypto\') with crypto in bridge.ts');