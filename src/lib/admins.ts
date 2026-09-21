/**
 * The minimal viable version of "a named human decides." No login, no
 * sessions — just a configured allowlist of names an approve/promote call
 * must match, so `approved_by`/`promoted_by` can never be arbitrary free
 * text. Real identity (SSO/OIDC) is a separate, later step; this exists so
 * that step isn't a prerequisite for the two-tier approval model itself.
 */
import { query } from "@/lib/db";

function parseAdminNames(raw: string | undefined): string[] {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function listAdmins(): string[] {
  return parseAdminNames(process.env.ADMIN_NAMES);
}

export function isAdmin(name: string): boolean {
  return listAdmins().includes(name);
}

/**
 * Is `name` allowed to PROMOTE (tier 2), as opposed to merely approve
 * (tier 1)? db/schema.sql's `settings.promote_admins` is the narrower
 * "Hero Agents" roster (D64) - a subset of ADMIN_NAMES trusted with the
 * broader-visibility action. NULL/empty (the default - nobody has set one)
 * means any admin may promote, which is today's behavior everywhere else
 * this file is used; a non-empty roster narrows it. Fails open to "any
 * admin" on a query error, same posture as isAdmin: a broken check must
 * never silently lock every admin out.
 */
export async function isPromoteAdmin(name: string): Promise<boolean> {
  if (!isAdmin(name)) return false;
  try {
    const [row] = await query<{ promote_admins: string[] | null }>(
      `SELECT promote_admins FROM settings WHERE id = 1`,
    );
    const roster = row?.promote_admins;
    if (!roster || roster.length === 0) return true;
    return roster.includes(name);
  } catch {
    return true;
  }
}
