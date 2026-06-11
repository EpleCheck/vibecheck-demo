# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report vulnerabilities privately to **post@eplecheck.no**, or use GitHub's
[private vulnerability reporting](https://github.com/EpleCheck/vibecheck/security/advisories/new).

Include what you found, how to reproduce it, and the potential impact. We aim to
acknowledge reports within a few business days and will keep you updated on the fix.

## Scope notes

VibeCheck commits content into your git repo using a token you provide. Keep that
token (and your `MCP_AUTH_TOKEN`) secret — store them as environment variables or
your host's secret store, never in committed files. The repo's `.gitignore`
excludes `.env` by default.
