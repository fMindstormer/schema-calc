// Every GitHub release the README links must exist and be published, with every
// file the README downloads from it attached. Uses the GitHub CLI; in Actions,
// set GH_TOKEN. Usage: node scripts/check-release-links.mjs [README.md]
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const path = process.argv[2] ?? new URL('../README.md', import.meta.url);
const text = await readFile(path, 'utf8');
const RELEASE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/(?:tag|download)\/([\w.-]+)/g;
const releases = new Map();
for (const [, repo, tag] of text.matchAll(RELEASE)) releases.set(`${repo}@${tag}`, { repo, tag, files: new Set() });
// Files fetched as "$base/$f" for each f in a shell loop, after base=<download URL>.
for (const [, repo, tag, files] of text.matchAll(/^base=https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/download\/([\w.-]+)\n(?:.*\n)*?for f in ([^;]+); do curl [^\n]*"\$base\/\$f"/gm)) {
  for (const file of files.trim().split(/\s+/)) releases.get(`${repo}@${tag}`).files.add(file);
}
// And any file linked directly.
for (const [, repo, tag, file] of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/download\/([\w.-]+)\/([\w.-]+)/g)) {
  releases.get(`${repo}@${tag}`).files.add(file);
}
if (!releases.size) throw new Error(`${path} links no releases.`);

let failed = false;
for (const { repo, tag, files } of releases.values()) {
  let release;
  try {
    release = JSON.parse(execFileSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'tagName,isDraft,assets'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    console.error(`MISSING  ${repo} ${tag}: ${(error.stderr || error.message).trim()}`);
    failed = true;
    continue;
  }
  const attached = new Set(release.assets.map(asset => asset.name));
  const absent = [...files].filter(file => !attached.has(file));
  if (release.isDraft) console.error(`DRAFT    ${repo} ${tag}`);
  if (absent.length) console.error(`ASSETS   ${repo} ${tag} lacks ${absent.join(', ')}`);
  if (release.isDraft || absent.length) failed = true;
  else console.log(`OK       ${repo} ${tag}${files.size ? `, with ${[...files].join(', ')}` : ''}`);
}
process.exit(failed ? 1 : 0);
