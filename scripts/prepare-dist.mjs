import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

copyFileSync('src/wa-sqlite-private.d.ts', 'dist/wa-sqlite-private.d.ts');
mkdirSync('dist/vendor', { recursive: true });
copyFileSync('src/vendor/WriteAhead.js', 'dist/vendor/WriteAhead.js');

const indexDeclarationPath = 'dist/index.d.ts';
const reference = '/// <reference path="./wa-sqlite-private.d.ts" />\n';
const indexDeclaration = readFileSync(indexDeclarationPath, 'utf8');

if (!indexDeclaration.startsWith(reference)) {
    writeFileSync(indexDeclarationPath, `${reference}${indexDeclaration}`);
}
