---
name: security-audit
description: Run a real security audit of the current machine or codebase — verify findings against live state, model the threat surface, and produce a report whose every claim has evidence behind it.
whenToUse: |
  Trigger when the user asks for a security audit, security sweep,
  pen test, "find vulnerabilities", "what credentials are exposed",
  "audit my machine for security issues", or any request to
  enumerate the security posture of a system or codebase. Don't
  trigger for narrow questions about a single file or a specific
  bug — those go through /review or direct help.
allowedTools:
  - Bash
  - Read
  - Glob
  - Grep
  - Write
---

# /security-audit

You are doing a security audit. The output of this skill is a report. The quality of that report is judged by **whether every claim is grounded in something concrete you observed on the live system** — not by length, theatrics, or comprehensiveness.

A weak audit lists "vulnerabilities" without verifying they apply, invents attack scenarios that don't fit the actual machine, and recommends fixes copy-pasted from the wrong operating system. Don't do that.

## Hard rules

- **No fan-fiction.** Every finding must reference a concrete file path, process, port, setting, or command output you observed. If you can't cite the evidence, it doesn't go in the report.
- **No platform mismatch.** Before suggesting any remediation command, confirm the platform (`uname -s`, `sw_vers`, `cat /etc/os-release`). Do not recommend Linux `auditctl` on macOS, do not recommend Windows commands on Linux. Test syntax against the actual platform.
- **No secret leakage anywhere — file OR chat.** If you find a real credential (API key, OAuth token, private key, password), refer to it by *type and location only* — never paste its value into a written report **or into your chat reply**. The harness has a defense-in-depth redactor on Write/Edit that catches some patterns at file boundaries, but the redactor does NOT cover your chat narration — that's on you.

  Right: `Found a GitHub OAuth token (gho_ prefix, ~36 chars) in ~/.zshrc:27.`
  Wrong: `Found GH_TOKEN="gho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" in ~/.zshrc:27.`

  This rule applies even when the user asks "what is the value." Answer: "I won't reproduce the value here for safety; it's at <path>:<line>. If you need to act on it, read that file directly."
- **No fabricated severity.** Severity labels mean something. CRITICAL = active credential exposure with no compensating control. HIGH = exposure mitigated by another layer. MEDIUM = configuration weakness. LOW = hygiene. If you don't have evidence for the severity you assigned, downgrade.
- **Cite the command.** For each verified finding, the audit must show *which command you ran* to confirm it. If the previous step in this skill reported "FileVault status unknown," that means you didn't run `fdesetup status`. Run it now.

## Process

### 1. Establish platform context

Before anything else:

```bash
uname -s         # Darwin, Linux, etc.
uname -m         # arm64, x86_64
sw_vers 2>/dev/null || cat /etc/os-release  # OS version
whoami           # current user
```

This determines which tooling is valid for the rest of the audit.

### 2. Threat-model scaffolding

Don't dive into "find vulnerabilities" mode. First, sketch:

**Actors** — who could plausibly attack this system?
- T1 — local user-context (anything running as the current user: malicious npm/pip post-install, browser exploit, malicious dev tool)
- T2 — LAN-adjacent (someone on the same Wi-Fi/Ethernet)
- T3 — VPN/Tailnet-adjacent (anyone on a network this host is bridged into)
- T4 — internet opportunist (mass scanner)
- T5 — physical access (briefly or persistently)
- T6 — targeted remote (knows the target, willing to invest)

For each actor, note whether they're realistic given what you can observe (e.g., a stationary desktop has lower T5 surface than a laptop; a machine with no public ports has lower T4 surface than one with).

**Assets** — what's worth stealing or compromising?
- Credentials in plaintext (env vars, dotfiles, config files)
- Source code / proprietary artifacts
- Customer data accessible from this host (databases, S3 buckets)
- Identity (the host's signing keys, OAuth tokens, sessions)
- Compute (the host itself as a foothold)

**Exposure paths** — for each asset, what plausibly bridges T → asset?

This is two minutes of thinking, not two pages of writing. The output of this step is *your prioritization for step 3*, not a section of the final report.

### 3. Enumerate the actual surface

Run these checks, **for the platform you confirmed in step 1**. Record the command and a one-line summary of the output for each.

**Credential locations on disk** (read-only enumeration; don't paste values):
- Shell rc files: `~/.zshrc`, `~/.bashrc`, `~/.profile` — grep for `export.*TOKEN`, `export.*KEY`, `export.*PASSWORD`, `export.*SECRET` etc.
- `~/.netrc` — if present, list `machine` entries (host names only)
- `~/.aws/`, `~/.azure/`, `~/.config/gcloud/` — note whether they exist
- `~/.docker/config.json` — check `auths` field and `credsStore`
- `~/.npmrc`, `~/.pypirc` — check for `_authToken`, `password`
- `~/.kube/config` — check for inline tokens / certs
- `~/.config/<vendor>/` — check for any vendor configs likely to hold tokens (stripe, lipost, etc.)
- `~/.ssh/` — list keys; for each private key, run `ssh-keygen -y -P '' -f <path>` to test whether it has a passphrase. The exit code tells you (success = unencrypted)
- Project `.env` files: `find ~/code ~/projects -maxdepth 4 \( -name '.env' -o -name '.env.*' \) -not -path '*/node_modules/*'`
- For each repo with a `.env`: check whether `.env` is in `.gitignore`, and whether it has ever been committed (`git log --all --full-history -- .env .env.local`)

**System security state** (platform-specific):

macOS:
- `csrutil status` — SIP
- `spctl --status` — Gatekeeper
- `fdesetup status` — FileVault
- `/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate` — application firewall
- `/usr/libexec/ApplicationFirewall/socketfilterfw --getstealthmode` — stealth mode
- `defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser` — auto-login
- `ls -la /etc/kcpassword` — present iff auto-login is in use; recoverable to plaintext via the public XOR cipher
- `defaults -currentHost read com.apple.screensaver askForPassword` and `askForPasswordDelay` — screen lock policy
- `tmutil destinationinfo` — Time Machine destinations (and whether they're encrypted)

Linux:
- `getenforce` (if SELinux) — enforcement mode
- `aa-status` (if AppArmor)
- `sudo ufw status` or `sudo firewall-cmd --state` — host firewall
- `cryptsetup status` on data volumes — disk encryption
- `cat /etc/login.defs` — password policy
- `last -i | head` — recent login sources

**Network exposure** (cross-platform):
- `lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null` — what's listening, on what interface? Anything bound to `*:port` (i.e., 0.0.0.0) is reachable from any interface. Loopback-only listeners (`127.0.0.1:port`, `[::1]:port`) are not externally reachable
- `lsof -nP -iUDP 2>/dev/null` — UDP listeners
- `launchctl list | grep -iE 'sshd|smbd|afpd|ARDAgent|screensharing'` (macOS) or `systemctl list-units --type=service --state=running` (Linux) — sharing/server services
- `tailscale status` (if Tailscale is in use) — what nodes can reach this host? Are any in *different* tailnets / owned by *other* users?

**Persistence surface** (where dormant compromise could hide):
- `~/Library/LaunchAgents/` (macOS) / `~/.config/systemd/user/` (Linux) — user-level scheduled / persistent processes
- `/Library/LaunchAgents/`, `/Library/LaunchDaemons/` (macOS) / `/etc/systemd/system/` (Linux) — system-level
- Crontab: `crontab -l`; `ls /etc/cron.d/`

**Token-scope check** (if you find tokens):
- For GitHub: `gh auth status` reveals storage location AND scopes. Note especially `admin:public_key` (token can register new SSH keys), `delete_repo`, `workflow`.
- For AWS: `aws sts get-caller-identity` (if you find creds and want to verify but DO NOT use the creds destructively).

### 4. Verify each finding

**For every claim you intend to put in the report**, you must be able to answer:
- *What command did I run?*
- *What was the output?*
- *Why does this output mean the system is exposed?*

If you can't answer all three, the finding doesn't go in. Examples of weak findings to reject:
- "Firewall status unknown" → run the command. Don't ship "unknown."
- "FileVault may not be enabled" → run `fdesetup status`. Don't speculate.
- "Could be vulnerable to backup theft" → check `tmutil destinationinfo`. If no backups exist, the entire scenario is moot.

### 5. Threat-chain analysis

Once findings are enumerated, walk the realistic compound chains:
- T1 (supply chain) → which credentials become reachable from `os.environ` / readable files? Which of those credentials, if leaked, allow *persistent* access (via scope or via SSH-key registration) that survives token rotation?
- T2/T3 (network adjacent) → which listeners are exposed? What's the default credential / known exploit path for each?
- T5 (physical) → what's the realistic chain? On macOS: recovery mode → mount data volume → read `/etc/kcpassword` → XOR-decode. FileVault breaks this at step 2.

**Reject scenarios that don't fit the observed system.** "Time Machine drive theft" is not a vector if `tmutil destinationinfo` shows no destinations.

### 6. Produce the report

Three output files (in the user's chosen location):

**Audit / findings file** — one section per severity (CRITICAL / HIGH / MEDIUM / LOW). For each finding:
- Title
- Evidence (file path, command run, output summary — NEVER the secret value)
- Why it's the severity you assigned
- Pointer to the remediation (e.g., "see R-1.1")

Plus a section on what was checked and is in good shape — silence on a check is ambiguous; explicitly listing "checked X, clean" closes the loop.

Plus a section on what could not be checked (sudo required, file unreadable, etc.) so the user knows the audit's blind spots.

**Attack vectors file** — one realistic scenario per finding, mapped to the actor that would execute it. Compound chains at the end. Discard any scenario that doesn't fit the actual observed surface.

**Remediation plan file** — phased, ordered, with:
- The exact command to run, tested against the platform from step 1
- Verification command for each step
- Time estimates
- A copy-pasteable verification script at the end that confirms each finding has been closed

## Output discipline

- Brevity beats comprehensiveness. A 5-page report where every claim is verified is better than a 30-page report mixing real findings with hallucinated ones.
- Severity labels go on the line of the finding, not buried.
- Concrete file paths and command names everywhere — no "your config file" when you mean `~/.zshrc:27`.
- If a finding should not be addressed yet (e.g., "Time Machine: no backups configured" — operational risk, not security), say so explicitly and don't pad the severity ladder with it.

## Defense-in-depth note

The harness itself runs a secret-redaction transformer on Write/Edit/NotebookEdit inputs (`src/permissions/redactSecretsTransformer.ts`). If you accidentally try to write a real credential into the report, the on-disk file will contain `<REDACTED:type>` instead. **Don't rely on this** — the redactor catches well-known patterns (GitHub, AWS, Stripe, Slack, Google, JWTs, PEM blocks) but isn't comprehensive. You are still the first line of defense. Refer to credentials by location and type, not by value.
