// The inbox push switches as this repo resolves them.

import { readInboxKnobs } from '../inbox-push.js';
import { check } from './check.js';

/**
 * The inbox push switches (synoptic 2.4.0), as this repo resolves
 * them: process env first, then `.claude/settings.local.json`, the same overlay
 * the watcher reads when it starts.
 *
 * A value that is neither of the two the code recognises is the failure worth
 * catching. `readInboxKnobs` treats anything but "off" as push ON and anything
 * but "on" as wake OFF, so `SYNOPTIC_INBOX_PUSH=false` silently does nothing. The
 * audit says so instead.
 *
 * The urgent allowlist is printed: kids are public directory names, not secrets.
 */
export function auditInboxPush({ env }) {
  const knobs = readInboxKnobs(env);
  const out = [];
  const pushRaw = env.SYNOPTIC_INBOX_PUSH;
  if (pushRaw !== undefined && pushRaw !== '' && pushRaw !== 'off' && pushRaw !== 'on') {
    out.push(
      check(
        'inbox.push',
        'warn',
        `SYNOPTIC_INBOX_PUSH="${pushRaw}" is not "off", so push stays on`,
        'only the literal "off" disables it'
      )
    );
  } else if (!knobs.push) {
    out.push(
      check(
        'inbox.push',
        'ok',
        'push off (SYNOPTIC_INBOX_PUSH=off)',
        'mail arrives as summary lines at the prompt and at Stop, as before 2.4.0'
      )
    );
  } else if (!env.SUBSTRATE_AGENT_KEY_ID) {
    out.push(
      check(
        'inbox.push',
        'warn',
        'push on, but no agent identity is wired',
        "the watcher needs SUBSTRATE_AGENT_KEY_ID to find this repo's inbox, so nothing is pushed"
      )
    );
  } else {
    out.push(
      check(
        'inbox.push',
        'ok',
        'push on: agent mail is delivered mid-turn',
        'SYNOPTIC_INBOX_PUSH=off is the rollback; it takes effect at the next session start'
      )
    );
  }

  const wakeRaw = env.SYNOPTIC_INBOX_WAKE;
  if (wakeRaw !== undefined && wakeRaw !== '' && wakeRaw !== 'on' && wakeRaw !== 'off') {
    out.push(
      check(
        'inbox.wake',
        'warn',
        `SYNOPTIC_INBOX_WAKE="${wakeRaw}" is not "on", so wake stays off`,
        'only the literal "on" enables it'
      )
    );
  } else {
    out.push(
      check(
        'inbox.wake',
        'ok',
        knobs.wake
          ? 'wake on: idle mail starts a turn (6/hour, 2/thread)'
          : 'wake off: idle mail waits for the next prompt'
      )
    );
  }

  out.push(
    knobs.urgentFrom.length === 0
      ? check('inbox.urgent', 'ok', 'urgent preemption off (no SYNOPTIC_INBOX_URGENT_FROM)')
      : check(
          'inbox.urgent',
          'ok',
          `urgent preemption allowed from ${knobs.urgentFrom.length} kid(s): ${knobs.urgentFrom.join(', ')}`,
          'their priority:urgent mail may stop a running turn (3/hour)'
        )
  );
  return out;
}
