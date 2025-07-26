const fs = require('fs');
const path = require('path');

const outputFile = 'copilot.md';
const language = 'plaintext'; // Change this as needed

// Files or folders to exclude (relative to root)
const exclude = [
  'node_modules',
  '.git',
  '.github',
  'merged.md',
  'README.md',
  'package-lock.json',
  'password.js',
  'copilot.md',
  'favicon.ico',
  '.gitignore',
  'package.json',
  'merge-files.cjs'
];

function shouldExclude(filePath) {
  return exclude.some(pattern => filePath.includes(pattern));
}

function getAllFiles(dirPath, arrayOfFiles = []) {
  const files = fs.readdirSync(dirPath);
  files.forEach(file => {
    const fullPath = path.join(dirPath, file);
    if (shouldExclude(fullPath)) return;
    if (fs.statSync(fullPath).isDirectory()) {
      getAllFiles(fullPath, arrayOfFiles);
    } else {
      arrayOfFiles.push(fullPath);
    }
  });
  return arrayOfFiles;
}

const allFiles = getAllFiles('./');
const markdownSections = allFiles.map(file => {
  const content = fs.readFileSync(file, 'utf8');
  return `## ${file}\n\`\`\`${language}\n${content}\n\`\`\`\n`;
});

fs.writeFileSync(outputFile, markdownSections.join('\n'));
console.log(`✅ Merged ${allFiles.length} files into ${outputFile}`);
