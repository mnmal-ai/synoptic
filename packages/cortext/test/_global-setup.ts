/**
 * The third pg guard, in globalSetup rather than
 * `_setup.ts`: the probe opens one connection per database on the server, and
 * setupFiles runs once per test file.
 *
 * `assertNotSuperuser` is a proxy for "this credential cannot damage
 * production" that holds only while prod runs as a superuser. Once prod is a
 * least-privilege role, a test URL carrying the PROD password passes both
 * name and superuser checks. This one asks postgres directly whether the role
 * owns, or can write to, anything in a database not named _test/_dev.
 *
 * The name check repeats here only so it runs first; `_setup.ts` keeps its own.
 * Both are owned by @mnmal-ai/substrate/testing — do not re-inline.
 */
import {
  assertCannotWriteOutsideTestDatabases,
  assertTestDatabase
} from '@mnmal-ai/substrate/testing';

const packageName = 'cortext-kernel';

export default async function setup(): Promise<void> {
  assertTestDatabase(process.env.POSTGRES_URL, { packageName });
  await assertCannotWriteOutsideTestDatabases(process.env.POSTGRES_URL, { packageName });
}
