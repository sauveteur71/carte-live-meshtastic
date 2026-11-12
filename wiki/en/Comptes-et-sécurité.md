# Accounts and security

## Roles
- **Administrator**: everything, including the radio node, settings and accounts.
- **Area manager**: programs remotely, fills in the installation sheet and tests **only the nodes of their area** (*Manage › Accounts › Area…*).
- **Member**: sees messages and exact positions.
- **Public**: no account, private individuals' positions rounded, no messages.

Registrations: closed, after approval or open (*Manage › Settings*).

## Protecting accounts
- **Two-factor authentication** (TOTP app: Google Authenticator, Aegis, 2FAS…) in *My account*. Recommended for everyone who programs relays.
- **Disconnect my other devices** in case of loss.
- **Audit log** (*Manage › Log*): logins, refusals, programming, accounts, settings. Passwords never appear.

## Network
- **Port 4404 (agents)**: never open to the internet; local network or VPN (Tailscale).
- Behind a reverse proxy, a request is never considered “local”: setup then always asks for a code.
- Channel keys and MeshCore passwords are kept in private files on the server, and backed up every night (*Manage › Backups*).

## Blocking after failed logins
As the map is reachable from the internet, password attempts are slowed down:
- **3 failures in 15 min from the same address**: the address is blocked for 15 min. Each repeat within 24 h doubles the duration (30 min, 1 h… up to 24 h).
- **3 failures in 15 min on the same account**, wherever they come from: login to this account is suspended for 15 min (fixed duration). From the local network or Tailscale, this suspension doesn't apply: the administrator can always log in from home.
- A wrong two-factor code counts as a failure. The message shows the remaining attempts.
- Blocks survive a restart. *Manage › Log* lists them, with an **Unblock** button. Each block and unblock is written to the log.
- Agents (port 4404) are protected the same way: 3 wrong codes in 15 min, address refused for 15 min.

Behind a reverse proxy (Caddy, Nginx…), the map must see visitors' real address: `PROXY_CONFIANCE` (default: local and private addresses) must include the proxy's address, otherwise all visitors share the proxy's address and a single attacker would block everyone.
