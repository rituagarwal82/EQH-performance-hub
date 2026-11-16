/**
 * Zoom host registry, host-email resolution and host backfill.
 *
 * Why this exists: four logins on the account have never hosted a session and
 * hold no Webinar licence, so Zoom refuses the webinar listing for them on
 * every 6-hourly run. That refusal was surfacing as a partial/late Zoom feed —
 * an alarm about a non-problem. A login is probed ONCE, the refusal is recorded
 * as an informational note, and it is re-probed weekly, never every cycle.
 */

import { pgSelect, pgUpdate, pgUpsert, type PgClient } from "./pg.server";
import { safeMessage } from "./safe-error";

export const HOST_REGISTRY_KEY = "zoom_host_registry";
const REPROBE_DAYS = 7;

export type HostRecord = {
  skip: boolean;
  reason: string;
  probed_at: string | null;
  next_probe_at: string | null;
  /**
   * Owner-settled logins: these are used for internal community sessions and
   * meetings and are not supposed to host webinars. They are never re-probed
   * and never reported as a problem.
   */
  permanent?: boolean;
};

export type HostRegistry = { hosts: Record<string, HostRecord> };

export async function readHostRegistry(pg: PgClient): Promise<HostRegistry> {
  try {
    const rows = await pgSelect<{ value: string | null }[]>(
      pg,
      `/app_settings?key=eq.${HOST_REGISTRY_KEY}&select=value`,
    );
    const raw = rows?.[0]?.value;
    if (!raw) return { hosts: {} };
    const parsed = JSON.parse(raw) as HostRegistry;
    return { hosts: parsed?.hosts ?? {} };
  } catch {
    // A registry we cannot read must never hide hosts: fall back to sweeping all.
    return { hosts: {} };
  }
}

export async function writeHostRegistry(pg: PgClient, registry: HostRegistry) {
  try {
    await pgUpsert(pg, "app_settings?on_conflict=key", {
      key: HOST_REGISTRY_KEY,
      value: JSON.stringify(registry),
      description:
        "Zoom logins skipped by the sync, with the reason and the weekly re-check date. Machine-managed.",
      updated_at: new Date().toISOString(),
    });
  } catch {
    /* the registry is an optimisation — never break a sync over it */
  }
}

/** True when this login is currently on the skip list and not yet due for a re-probe. */
export function isSkipped(registry: HostRegistry, keys: (string | null)[], now = Date.now()) {
  for (const k of keys) {
    if (!k) continue;
    const rec = registry.hosts[k.toLowerCase()] ?? registry.hosts[k];
    if (!rec?.skip) continue;
    // Settled by the owner: skipped for good, never probed again.
    if (rec.permanent) return rec;
    const due = rec.next_probe_at ? Date.parse(rec.next_probe_at) : 0;
    if (!Number.isFinite(due) || due > now) return rec;
  }
  return null;
}

/** True when this login is one the owner has settled as never hosting webinars. */
export function isByDesign(registry: HostRegistry, keys: (string | null)[]) {
  for (const k of keys) {
    if (!k) continue;
    const rec = registry.hosts[k.toLowerCase()] ?? registry.hosts[k];
    if (rec?.permanent) return true;
  }
  return false;
}


export function markSkipped(registry: HostRegistry, key: string, reason: string) {
  const now = new Date();
  registry.hosts[key.toLowerCase()] = {
    skip: true,
    reason,
    probed_at: now.toISOString(),
    next_probe_at: new Date(now.getTime() + REPROBE_DAYS * 86400000).toISOString(),
  };
}

export function markActive(registry: HostRegistry, key: string) {
  const rec = registry.hosts[key.toLowerCase()];
  if (!rec) return;
  delete registry.hosts[key.toLowerCase()];
}

export type ZoomFetch = <T>(path: string) => Promise<T>;

/**
 * id → email for EVERY login on the account, whatever its status. Sessions
 * carry a host_id; without this map per-host analysis reads as an opaque hash.
 */
export async function hostDirectory(fetchJson: ZoomFetch): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const status of ["active", "inactive", "pending"]) {
    try {
      const res = await fetchJson<{ users?: { id?: string; email?: string }[] }>(
        `/users?status=${status}&page_size=300`,
      );
      for (const u of res.users ?? []) if (u.id && u.email) map.set(u.id, u.email);
    } catch {
      /* one status list failing must not lose the others */
    }
  }
  return map;
}

export type HostBackfillResult = {
  scanned: number;
  recovered: number;
  unrecoverable: number;
  byHost: Record<string, number>;
  notes: string[];
};

/**
 * Fill host_email / host_id on sessions that have neither. Zoom's listing rows
 * for older instances omit the host entirely, so the host is read back from the
 * webinar or meeting definition and translated through the user directory.
 */
export async function backfillSessionHosts(
  pg: PgClient,
  fetchJson: ZoomFetch,
  encodeUuid: (u: string) => string,
  limit = 500,
): Promise<HostBackfillResult> {
  const out: HostBackfillResult = {
    scanned: 0,
    recovered: 0,
    unrecoverable: 0,
    byHost: {},
    notes: [],
  };

  const rows = await pgSelect<
    { session_uuid: string; zoom_id: string | null; session_type: string }[]
  >(
    pg,
    `/zoom_sessions?host_email=is.null&host_id=is.null&select=session_uuid,zoom_id,session_type&limit=${limit}`,
  );
  if (!rows?.length) return out;

  const directory = await hostDirectory(fetchJson);
  // Definitions repeat across occurrences; one lookup per definition is enough.
  const byDefinition = new Map<string, { host_id: string | null; host_email: string | null }>();

  for (const row of rows) {
    out.scanned += 1;
    let host: { host_id: string | null; host_email: string | null } | null = null;

    const defKey = `${row.session_type}:${row.zoom_id ?? ""}`;
    if (row.zoom_id && byDefinition.has(defKey)) {
      host = byDefinition.get(defKey)!;
    } else {
      const paths = row.zoom_id
        ? row.session_type === "webinar"
          ? [`/webinars/${encodeURIComponent(row.zoom_id)}`, `/report/webinars/${encodeUuid(row.session_uuid)}`]
          : [`/meetings/${encodeURIComponent(row.zoom_id)}`, `/report/meetings/${encodeUuid(row.session_uuid)}`]
        : [
            row.session_type === "webinar"
              ? `/report/webinars/${encodeUuid(row.session_uuid)}`
              : `/report/meetings/${encodeUuid(row.session_uuid)}`,
          ];
      for (const path of paths) {
        try {
          const res = await fetchJson<{ host_id?: string; host_email?: string; user_email?: string }>(
            path,
          );
          const hostId = res.host_id ?? null;
          const email = res.host_email ?? res.user_email ?? (hostId ? directory.get(hostId) ?? null : null);
          if (hostId || email) {
            host = { host_id: hostId, host_email: email };
            break;
          }
        } catch (e) {
          if (out.notes.length < 5) out.notes.push(`${row.session_uuid}: ${safeMessage(e)}`);
        }
      }
      if (row.zoom_id && host) byDefinition.set(defKey, host);
    }

    if (!host) {
      out.unrecoverable += 1;
      continue;
    }
    const email = host.host_email ?? (host.host_id ? directory.get(host.host_id) ?? null : null);
    try {
      await pgUpdate(pg, "zoom_sessions", `session_uuid=eq.${encodeURIComponent(row.session_uuid)}`, {
        host_email: email,
        host_id: host.host_id,
      });
      out.recovered += 1;
      const key = email ?? host.host_id ?? "unknown";
      out.byHost[key] = (out.byHost[key] ?? 0) + 1;
    } catch (e) {
      out.unrecoverable += 1;
      if (out.notes.length < 5) out.notes.push(`${row.session_uuid}: ${safeMessage(e)}`);
    }
  }
  return out;
}

/** Translate host_id-only sessions into emails using the account user list. */
export async function resolveHostEmails(pg: PgClient, fetchJson: ZoomFetch): Promise<{
  resolved: number;
  unresolved: string[];
}> {
  const rows = await pgSelect<{ session_uuid: string; host_id: string }[]>(
    pg,
    "/zoom_sessions?host_email=is.null&host_id=not.is.null&select=session_uuid,host_id&limit=2000",
  );
  if (!rows?.length) return { resolved: 0, unresolved: [] };
  const directory = await hostDirectory(fetchJson);
  let resolved = 0;
  const unresolved = new Set<string>();
  for (const row of rows) {
    const email = directory.get(row.host_id);
    if (!email) {
      unresolved.add(row.host_id);
      continue;
    }
    try {
      await pgUpdate(pg, "zoom_sessions", `session_uuid=eq.${encodeURIComponent(row.session_uuid)}`, {
        host_email: email,
      });
      resolved += 1;
    } catch {
      unresolved.add(row.host_id);
    }
  }
  return { resolved, unresolved: [...unresolved] };
}
