'use strict';
// Git state of the project checkout, for GET /__liivo/status (read by the
// gateway's stop check). node:child_process and node:fs only.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function git(projectDir, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd: projectDir,
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
        // Read-only: status must not rewrite the index, and nothing may prompt.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout) => resolve({ ok: !err, out: String(stdout || '').trim() })
    );
  });
}

function dirIsEmpty(dir) {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

// { checkout, clean, unpushed, branch }
//  - checkout: the project directory is a git checkout
//  - clean: no uncommitted or untracked files; with no checkout, whether the
//    directory is empty (files outside git count as work that would be lost)
//  - unpushed: commits not on the upstream branch, or on no remote at all when
//    the branch has no upstream
//  - branch: current branch name, null when detached or without a checkout
// Throws when git itself fails, so the caller can answer 500 instead of "clean".
async function workspaceStatus(projectDir) {
  if (!fs.existsSync(path.join(projectDir, '.git'))) {
    return { checkout: false, clean: dirIsEmpty(projectDir), unpushed: 0, branch: null };
  }
  const porcelain = await git(projectDir, ['status', '--porcelain']);
  if (!porcelain.ok) throw new Error('git status failed');
  const branchRes = await git(projectDir, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const head = await git(projectDir, ['rev-parse', '--verify', '-q', 'HEAD']);
  let unpushed = 0;
  if (head.ok) {
    let count = await git(projectDir, ['rev-list', '--count', '@{upstream}..HEAD']);
    if (!count.ok) count = await git(projectDir, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
    if (!count.ok) throw new Error('git rev-list failed');
    unpushed = Number(count.out);
  }
  return {
    checkout: true,
    clean: porcelain.out === '',
    unpushed,
    branch: branchRes.ok && branchRes.out ? branchRes.out : null,
  };
}

module.exports = { workspaceStatus };
