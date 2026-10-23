// The report's groups, from facts already gathered. Pure: it reads nothing.

import {
  auditAuthority,
  auditFragment,
  auditIdentity,
  auditInboxPush,
  auditMcpJson,
  auditOrphans,
  auditPlugin,
  check
} from '../audit.js';
import { createCortext } from '../capabilities/cortext.js';
import { compareVersions } from '../fragment-resolve.js';
import { auditPin, auditSkin } from '../marketplace-pin.js';
import { DIRECTORY_LIMIT } from './server.js';

/** @param {Record<string, any>} facts every gatherer's output, plus the target and cwd. */
export function buildGroups(facts) {
  const {
    pin,
    installedVersion,
    cloneFreshness,
    cloneDetail,
    opencodeSkinVersion,
    installedRegistry,
    candidates,
    cacheDirState,
    servedVersion,
    servedRootState,
    resolution,
    kid,
    source,
    declaredName,
    declaredKid,
    keyNames,
    revokedNames,
    directoryKids,
    activeKids,
    directoryRows,
    whoami,
    authWarning,
    targetDir,
    cwd,
    env,
    keyRefs,
    refScanComplete,
    mcpJsonFacts,
    recallFindings,
    settingsFindings,
    fleetFindings,
    hostFindings
  } = facts;
  return [
    [
      'pin',
      auditPin({
        pin,
        installedVersion,
        cloneFreshness,
        cloneDetail,
        compare: compareVersions
      }).map((f) => check(f.id, f.state, f.text, f.detail))
    ],
    [
      'skins',
      auditSkin({
        pinVersion: pin?.version ?? null,
        opencodeInstalledVersion: opencodeSkinVersion,
        compare: compareVersions
      }).map((f) => check(f.id, f.state, f.text, f.detail))
    ],
    [
      'plugin',
      auditPlugin({
        installedVersion,
        installedRegistry,
        cacheVersions: candidates.map((c) => c.version),
        cacheDir: cacheDirState,
        servedVersion,
        servedRoot: servedRootState,
        compare: compareVersions
      })
    ],
    ['fragment', auditFragment(resolution)],
    [
      'identity',
      auditIdentity({
        resolvedKid: kid,
        source,
        declaredName,
        keyFilePresent:
          keyNames === null || kid === null ? null : keyNames.includes(kid.split('@')[0]),
        directoryKids
      })
    ],
    [
      'authority',
      auditAuthority({
        whoami,
        // Whoami answers for the credential THIS PROCESS holds, so the
        // grant is only the target's when a target-derived fact says the subject
        // is the same. Both are passed; neither is this process's own env.
        declaredKid,
        selfAudit: targetDir === cwd,
        // The signer's own reason, so a broken key file is reported as a
        // broken key file rather than as absent wiring.
        authWarning,
        // The capability declares the namespaces it reads/writes; that is the
        // same list `provisionIdentity` hands `--ns`, so the grant and the
        // requirement are checked against one source rather than two.
        // Bound to the SAME namespace this instance runs (`SUBSTRATE_NAMESPACE`), so a
        // born-neutral deployment checks its own coordination namespace rather
        // than the literal 'cortext'.
        expectedNamespaces: createCortext(env.SUBSTRATE_NAMESPACE ?? 'cortext').namespaces,
        expectedCapabilities: createCortext(env.SUBSTRATE_NAMESPACE ?? 'cortext').needs,
        resolvedKid: kid
      })
    ],
    [
      'drift',
      [
        ...auditOrphans({
          keyNames,
          revokedNames,
          directoryKids,
          activeKids,
          directoryRows,
          keyRefs,
          refScanComplete
        }),
        ...(directoryRows !== null && directoryRows.length >= DIRECTORY_LIMIT
          ? [
              check(
                'directory.truncated',
                'unknown',
                `read ${directoryRows.length} AgentIdentity rows, the query limit, so some may be missing`,
                '"unregistered" and "never reported" findings may be false; this audit does not page'
              )
            ]
          : [])
      ]
    ],
    ['mcp-json', auditMcpJson(mcpJsonFacts)],
    ['inbox push', auditInboxPush({ env })],
    ['recall', recallFindings],
    ['settings', settingsFindings],
    ...(fleetFindings === null ? [] : [['fleet', fleetFindings]]),
    ...(hostFindings === null ? [] : [['hosts', hostFindings]])
  ];
}
