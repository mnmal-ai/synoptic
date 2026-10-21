/**
 * Safety rails for this package's pg-gated migration tests, which run DDL
 * (ADD/DROP/VALIDATE CONSTRAINT) against the shared rows table on
 * whatever database POSTGRES_URL names.
 *
 * Both guards are owned by @mnmal-ai/substrate/testing. Do not re-inline
 * them; hand copies drift. Import the owner.
 *
 * The name check alone is not sufficient: it says nothing about the
 * credential, and a SUPERUSER is exempt from every grant that would otherwise
 * contain a mistargeted suite. assertNotSuperuser closes that, so the suite
 * needs a least-privilege role (provisioning is documented in the substrate
 * repo).
 */
import { assertNotSuperuser, assertTestDatabase } from '@mnmal-ai/substrate/testing';

const packageName = 'cortext-kernel';

assertTestDatabase(process.env.POSTGRES_URL, { packageName });
await assertNotSuperuser(process.env.POSTGRES_URL, { packageName });
