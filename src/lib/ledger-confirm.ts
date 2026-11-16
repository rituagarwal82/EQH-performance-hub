/**
 * The one phrase that authorises replacing the whole collections ledger.
 *
 * It lives in its own client-safe module because both halves need it: the
 * screen that asks the reader to type it, and the server that refuses the
 * re-import without it. Anything else — including an empty string — is
 * refused before a single row is touched.
 */
export const LEDGER_REBUILD_PHRASE = "REPLACE LEDGER";
