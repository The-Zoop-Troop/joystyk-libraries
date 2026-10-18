# Security and trust

Contracts never trust client-reported outcomes. Parse commands and storage; keep hidden game
state server-side where authority requires it. Avoid personal data in logs and metrics. Network
limits use a trusted socket/proxy chain and canonical network keys.

CI contributions run on disposable GitHub-hosted runners with read-only repository permissions.
Release staging runs only from reviewed main in the protected npm environment with OIDC.
Never put long-lived npm credentials in this source. Preserve the separate dependency and
word-list licenses. External publication and repository changes require owner authorization.

The source exporter excludes host applications, game implementations, operational files,
untracked files and private tracker data. Local review precedes any public push.
