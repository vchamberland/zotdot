# PUBLIC REPOSITORY

This repository is published on GitHub (`vchamberland/zotdot`) and mirrored from the author's private Forgejo.
Everything committed here is public: no credentials, no private hostnames or network addresses, no personal paths, no host-specific config.

A pre-push guard (`.githooks/pre-push`) blocks pushes containing private IPs, Tailscale MagicDNS names, home-directory paths, private keys or common API tokens. Enable it in every clone:

    git config core.hooksPath .githooks
