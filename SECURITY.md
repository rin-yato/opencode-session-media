# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/rin-yato/opencode-session-media/security/advisories/new).
Do not open a public issue.

Include the plugin version, your OS and OpenCode versions, and steps to reproduce.

## Scope

This plugin runs locally. It reads a session's messages from OpenCode and, for
image files whose absolute path a tool printed, reads those files from disk
(PNG, JPEG, GIF, and WebP only, up to 20 MB). It sends no telemetry and makes no
outbound requests.

Reports about the plugin's own code are in scope. Issues in OpenCode belong with
that project.

## Supported versions

Only the latest published release receives fixes.
