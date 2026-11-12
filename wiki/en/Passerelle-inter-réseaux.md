# Meshtastic ⇄ MeshCore cross-network bridge

Relays **channel text messages** between a Meshtastic channel and a MeshCore channel. It is an **auxiliary tool** (exercise, event, outage of one of the two networks), not a permanent bridge: it is **off by default**.

## Enable
Administrator: *Tools › ⇄ Cross-network bridge* › **⏻ Enable the bridge** (or ⚙️🔎 “bridge”). Rules can be prepared before enabling; **⏻ Disable** turns everything off while keeping the rules, **⏸ Pause** suspends relaying for a while. The choice is kept after a restart.

In the `.env`, optional: `PASSERELLE=1` enables it at first startup; `PASSERELLE=0` **forbids** it on this map (the menu disappears, even for an administrator).

A **main Meshtastic node** and a **main MeshCore companion** must be linked to the map: they transmit the relayed messages. Incoming messages are those the map already decodes (MQTT, node, companion, observers).

## Rules
**🔗 Links (channels)** tab (it opens by itself when the bridge is enabled, or as long as no link exists): the **Meshtastic channel** on the left and the **MeshCore channel** on the right, where messages will be exchanged (for example `ADRASEC43` ⇄ `#adrasec`), the direction (MT → MC, MC → MT or MT ⇄ MC), then **Create link**.
- Each side lists the node's (or companion's) channels. If it is not linked, the map suggests the channels it knows (settings); **Other channel** lets you type any name.
- A link can therefore be prepared with the node unplugged: it works as soon as the node and the companion have this channel. The channel is found by its **name** at each send (whatever its place in the node's list); if it is missing, the log says so. Each rule can be suspended in one click, and the whole bridge can be paused at the top of the panel.

Per rule, **filters**: blocked senders, required word, excluded words (e.g. `!pos`), minimum length, quiet hours (e.g. `22-7`), and **Group**: messages received within the window (10, 30 or 60 s) go out in a single transmission (`[MC] Bob: hi / Alice: how are you?`).

The Meshtastic primary channel (channel 0) is excluded by default (can be allowed in the settings).

## Try a message, profiles
- **🧪 Try a message** (Links tab): give the destination network, channel, sender and a text. The bridge says what it would do with it (relayed, to which channel, with which text, or refused and why). **Nothing is sent.**
- **🗂️ Profiles**: save the current configuration (links, blacklist, settings) under a name (“normal”, “crisis”…) and load it again in one click.

## Always-on protections
- **Anti-echo**: what our own nodes send is never picked up again (otherwise everything would be doubled).
- **Anti-loop**: a text starting with `[MT]` or `[MC]` (adjustable prefixes) is never re-transmitted.
- **Anti-duplicate**: same channel, same sender, same text within 10 min (adjustable).
- **Quotas**: 6 messages per minute per rule and per direction, 60 for the whole bridge, at least 4 s between two transmissions on a network, queue of 10 messages: beyond that, the oldest are dropped (never a burst to catch up).
- **Node offline**: messages wait for it to return (bounded queue).
- Size: 200 bytes on the Meshtastic side, 140 on the MeshCore side (including the companion's name), text truncated beyond.

## Blacklist
**Blacklist** tab: choose a user among the known nodes; their messages are never relayed again (they still receive those of their own network). “Also in the other network” blocks the same name on both sides.

## Log, messages, statistics and alerts
- **Messages** tab (Meshtastic and MeshCore): **⇄ Relayed by the bridge** choice, and a “⇄ bridge” label on each relayed message.
- **Statistics** screen: messages relayed per direction and ignored per reason.
- **“Bridge offline” alert** when a transmitting node of an active link is unreachable; its messages wait in the queue, the link resumes by itself.

The dashboard counts messages relayed per direction and messages ignored per reason; the live log shows each message received, relayed or ignored with its reason. Creating, suspending and deleting rules, and the blacklist, are written to the audit log. Relayed messages never appear on the public map.
