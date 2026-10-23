// Whether semantic recall answers for this credential.

import { check } from './check.js';

/**
 * Is semantic recall reachable at all, for this credential?
 *
 * One line, stating which branch was taken rather than reporting faults: a
 * credential whose grant omits `recall` gets per-key `unauthorized_namespace`
 * rejections that nothing else surfaces.
 *
 * ## Why this needs `reachable` and cannot infer it
 *
 * `recall` returns null for a refusal AND for an unreachable server — the
 * two are deliberately merged there. An audit's response to them is NOT the same. "Recall
 * does not answer" is a verified fault; "the server is down" is a check that
 * could not run, and this module's one rule is that those must never render
 * alike. Reported as a warn on an unreachable box, this line would assert a
 * defect it never observed — the false-confidence bug inverted, which is no
 * better for being loud instead of quiet.
 *
 * With the server up this branch is unreachable, so test it against a dead
 * port.
 *
 * @param {{ answered: boolean, reachable: boolean, reason: string|null }} p
 */
export function auditSemanticRecall({ answered, reachable, reason, credentialAttributed = true }) {
  // Recall answering is a fact about the CREDENTIAL that asked. A repo
  // whose grant omits `recall` degrades silently while the auditor's
  // credential answers fine, so a probe signed by someone else reports the
  // auditor's ranker as the target's — in whichever direction flatters.
  if (!credentialAttributed) {
    return [
      check(
        'recall.available',
        'unknown',
        'recall was probed with a credential that is not established as this target’s',
        'whether recall answers depends on the asking credential’s namespace grant, so this probe answers for the auditor. See the authority section — the same substitution, one section up.'
      )
    ];
  }
  if (answered) {
    return [check('recall.available', 'ok', 'semantic recall answers')];
  }
  if (!reachable) {
    return [
      check(
        'recall.available',
        'unknown',
        'could not reach the server, so whether recall answers is unknown',
        `${reason ?? 'no reason given'} — an unreachable server is a check that did not run, not a recall fault`
      )
    ];
  }
  return [
    check(
      'recall.available',
      'warn',
      'semantic recall does NOT answer for this credential',
      `${reason ?? 'no reason given'} — the recall tool and recall/Hit frames fail for this credential; check its grant includes \`recall\``
    )
  ];
}
