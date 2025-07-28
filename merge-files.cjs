const fs = require('fs');
const path = require('path');

const outputFile = 'copilot.md';

// Maps file extensions to language tags
const extensionToLanguage = {
  '.js': 'javascript',
  '.ts': 'typescript',
  '.json': 'json',
  '.md': 'markdown',
  '.sh': 'bash',
  '.html': 'html',
  '.css': 'css',
  '.py': 'python',
  '.txt': 'plaintext'
};

// Files or folders to exclude
const exclude = [
  'node_modules',
  '.git',
  '.github',
  'README.md',
  'package-lock.json',
  'password.js',
  'favicon.ico',
  '.gitignore',
  'merge-files.cjs',
  'copilot.md'
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

function getLanguageTag(filePath) {
  const ext = path.extname(filePath);
  return extensionToLanguage[ext] || 'plaintext';
}

// Clear the output file
fs.writeFileSync(outputFile, '');

const allFiles = getAllFiles('./');
const markdownSections = allFiles.map(file => {
  const content = fs.readFileSync(file, 'utf8');
  const language = getLanguageTag(file);
  return `## ${file}\n\`\`\`${language}\n${content}\n\`\`\`\n`;
});

fs.writeFileSync(outputFile, markdownSections.join('\n'));
console.log(`Merged ${allFiles.length} files into ${outputFile}`);
