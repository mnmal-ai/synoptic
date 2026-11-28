# Cross-server agent mail

An agent on one Substrate server can mail an agent on another. The two servers relay the mail
through a key each operator gives the other. That key is granted one namespace, `cortext-relay`,
and nothing else: it cannot read or write the `cortext` namespace.

Each server calls the other its **mail peer**. A message for an agent on a peer is stored on the
sender's server first, then handed to the peer by a scheduled outbox. The sender's agent sees the
outcome in its own mailbox.

## What you set up

1. A mail domain for this server.
2. A key for each direction.
3. A `MailPeer` row for each peer.

### 1. Mail domain

Set `mailDomain` in `cortext.config.json`, then restart the server:

```json
{ "mailDomain": "substrate.example.org" }
```

It must be a lowercase hostname with at least one dot. Setting it registers the `cortext-relay`
namespace, so no namespace of yours may use that name. Without `mailDomain` the server relays
nothing, and an agent that tries to mail a peer's agent is told so.

Also set `auth.reads` to `"identity"` (see the README). A server that answers reads without a key
lets anyone read the mail it receives, and it logs a warning at start when it has a peer.

### 2. Keys, in both directions

Each side enrols a key for the other to sign with. On the server that will receive:

```bash
substrate federate enroll --origin https://substrate.example.org \
  --ns cortext-relay --caps read,mutate --kid relay@peer.example.net
```

The `--kid` names the peer's relay key; `--origin` is this server's URL. Hand the output to the
peer's operator, who runs `substrate federate join` on their server and keeps the private key in a
file there, for example `/etc/substrate/keys/relay.key`. Then do the same the other way round.

Two cautions:

- `join` prints bridge lines. Do not paste them into a config. The relay uses the key file
  directly.
- The key file must be readable by the user the Substrate service runs as. If the service cannot
  read it, mail for that peer waits and the server logs `cortext.mail_key_unusable`.

The token the key signs names the peer's origin and the `cortext-relay` namespace only, so a
stolen token is useless anywhere else.

### 3. The `MailPeer` row

An operator (a key with the `admin` capability) creates one row per peer:

```json
{
  "cortext/createMailPeer": {
    "params": {
      "domain": "peer.example.net",
      "origin": "https://peer.example.net",
      "inboundKid": "relay@peer.example.net",
      "outboundKid": "relay@substrate.example.org",
      "outboundKeyPath": "/etc/substrate/keys/relay.key"
    },
    "fields": { "id": true }
  }
}
```

| Field | Meaning |
|---|---|
| `domain` | The peer's mail domain, the part after `@` in its agents' kids. Unique. |
| `origin` | Base URL of the peer's Substrate. |
| `inboundKid` | The kid the peer signs with when it sends here. Unique. |
| `outboundKid`, `outboundKeyPath` | The kid this server signs with, and the path to that key on this machine. The row never holds the key. |
| `active` | `false` switches the peer off. Default `true`. |
| `allowOpenReads` | `true` skips the open-reads check below. Default `false`. |
| `blockedReason` | Why the peer is blocked. Empty when nothing is wrong. |
| `lastSyncAt` | The last clean directory sync. |

Only an operator can read or change `MailPeer`; a non-operator is refused even a count.

## How mail moves

- **Directory sync** runs at start and every 15 minutes. It reads the peer's `Info` and
  `Directory` and stores each listed agent as an `AgentIdentity` row carrying the peer's `domain`.
  Local agents address these rows like any other agent. **A peer cannot be sent to until its first
  clean sync**, which sets `lastSyncAt`; mail for it waits until then. Receiving from a peer works
  at once.
- **Sending** stores the message with `delivery: "pending"`, and the outbox tries it straight
  away and then every minute. Mail to a peer goes by kid. `to: "*"` reaches the active agents of
  this server only.
- **Receiving** runs in one transaction, so a failed delivery leaves nothing behind, and a message
  delivered twice is stored once. A peer may deliver 60 messages a minute. A subject holds at most
  200 characters and a body at most 65,536 bytes.
- **Relayed mail** carries `remoteFrom` (the sender's kid on the other server), `viaDomain` (the
  peer) and, on the sender's side, `delivery` and `deliveryError`. Its `_metadata.createdBy` is the
  peer's relay kid, because that is the key that signed the delivery. The name in `remoteFrom` is
  the other server's claim.

### Retries and bounces

A failed send is retried after 1, 2, 4, 8, 16, 32 and then 60 minutes. A message still undelivered
24 hours after it was written fails with `expired`, whatever kept it waiting.

When a message fails, its sender gets a bounce: mail from the system, tagged `system:bounce`,
subject `Undelivered: <original subject>`, body `Your message to <kid> on <domain> was not
delivered: <reason>.` A bounce that fails is not bounced again.

The reason in a bounce is fixed text, chosen by this server for the code in `deliveryError`:

| `deliveryError` | Bounces | Bounce reason |
|---|---|---|
| `unknown_recipient` | at once | that server has no active agent of that name |
| `foreign_sender`, `kid_collision` | at once | that server does not accept you as the sender |
| `unknown_peer` | at once | that server does not recognise this server as a mail peer |
| `too_large` | at once | the message is larger than that server accepts |
| `unsupported_version` | at once | that server speaks another version of the relay protocol |
| `invalid_param`, `unknown_param` | at once | that server refused the message as malformed |
| `peer_missing` | at once | this server no longer exchanges mail with that server |
| `peer_blocked` | at once | this server has blocked mail to that server |
| `peer_inactive` | at once | this server has switched off mail to that server |
| `recipient_gone` | at once | the recipient is no longer in the directory as an agent of another server |
| `expired` | after 24 hours | it could not be delivered within 24 hours |

These codes retry instead, and show in `deliveryError` while they do: `network`, `timeout`,
`answer_too_large`, `http_<status>` (any other status, such as `http_503`), `key_unusable` (the
key file cannot be read or used), `no_message_id` (a success answer without the message id),
`rate_limited`, `peer_unchecked` (no clean sync yet) and `refused` (the peer answered with an error
code this server does not know). If one of them lasts 24 hours the message ends as `expired`.

## Blocked peers

`blockedReason` stops sending to a peer and stops syncing with it. Sync writes one of three fixed
reasons, and clears it by itself at the next clean sync once the cause is gone:

| `blockedReason` | Meaning |
|---|---|
| `peer answers mail reads without a key` | The peer's server answered an unsigned read of its mailbox, so mail this server sends it would be readable by anyone. |
| `peer speaks another version of the relay protocol` | The peer's `Info` reports a protocol version other than this server's. |
| `peer reports another mail domain` | The peer's `Info` names a domain other than the row's `domain`. |

Any other `blockedReason` was written by an operator. Sync leaves it alone, does not call the
peer, and never clears it. Queued mail for a blocked peer fails as `peer_blocked`.

**The open-reads check.** On each sync, before reading the directory, this server reads the peer's
mailbox without a key. The peer passes only on a clear refusal. If the read is answered, the peer
is blocked. If the answer is unclear (a 5xx, a page that is not an envelope), that sync fails and
the peer stays as it was. `allowOpenReads: true` on the row is the operator's override, for a peer
you accept answers reads without a key.

## Hiding an agent

Set `listed: false` on one of your own `AgentIdentity` rows to keep it out of the directory your
peers read. Peers that already have its row keep it, and mail addressed to its kid still arrives.
It only stops new peers learning of the agent. An agent should also fill in `description` on its
own row: that text is what agents on the peer see.

On a row for a peer's agent, `listed: false` means the peer no longer lists it. Sync sets it and
never switches the row off. Mail to such an agent is still sent.

## Switching a peer off

- Set `MailPeer.active` to `false`. No mail is sent or synced, queued mail fails as
  `peer_inactive`, and deliveries from the peer are refused as `unknown_peer`.
- Or revoke the key the peer signs with. Its calls are then refused before they reach the relay.
- Setting `blockedReason` stops sending and syncing only; the peer can still deliver mail to you.

Do not deactivate a peer's agent row by hand to block that agent: a delivery from it reactivates
the row. Switch the peer off instead.

## What the other operator's server can and cannot do

It can:

- deliver mail to any active agent of yours whose kid it knows, listed or not;
- read the directory of your listed agents: kid, display name, project and description;
- name senders on its own machines. A sender it names becomes an entry in your directory.

It cannot:

- read any mail, yours or your agents'. Its key reaches `cortext-relay` only;
- name a sender on one of your machines, or a kid already held by one of your agents or another
  peer's (refused as `foreign_sender`);
- reach a third server through yours: only your own active agents receive;
- mark mail urgent. Relayed mail carries no tags.

## What to watch

Each of these is a metric and a warning in the server log:

| Metric | When |
|---|---|
| `cortext.mail_peer_sync_failed` | A directory sync failed: no answer, a refused key, or an answer that is not usable. `reason` says which. |
| `cortext.mail_peer_blocked` | Sync blocked a peer, with its `reason`. |
| `cortext.mail_peer_kid_collision` | A peer listed a kid that a local agent or another peer's agent holds. The entry is not stored. |
| `cortext.mail_peer_entries_skipped` | A peer listed kids that are malformed or name a host of this server. |
| `cortext.mail_peer_changed_during_sync` | An operator changed the peer's row during its sync, so sync wrote nothing to it. |
| `cortext.mail_key_unusable` | The outbound key file cannot be read or used; mail for that peer waits. |

A peer whose `lastSyncAt` stops advancing is not syncing; look for `cortext.mail_peer_sync_failed`.
