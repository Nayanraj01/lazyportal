import { parseClassLogs } from "./attendanceCalc";
import { doesSubjectNeedDeepFetch, computeSubjectRowChecksum, getPortalDayKey, recordSuccessfulManualRefresh } from "./portalSchedule";
import { getCachedSubjectDetailEntry, getSubjectCacheKey, refreshSubjectDetail, rowSubId, type AttRow } from "../sections/attendance";
import type { Session } from "../types";
import type { AttData } from "../sections/attendance";

type Detail = Record<string, Record<string, unknown>>;

/** Successful reads from an unfinished manual refresh, scoped by full cache key. */
export interface ManualAttendanceRefreshCheckpoint {
  portalDay?: string;
  details: Map<string, Detail>;
  changed?: boolean;
}

/** Compare attendance records, not response metadata or array/property order. */
export function detailSignature(detail: Detail | null) {
  if (!detail) return null;
  return JSON.stringify(["L", "T", "P"].map((type) => {
    const parsed = parseClassLogs(detail[type], type);
    return parsed ? [type, parsed.total, parsed.attended,
      parsed.classes.map((r) => `${r.datetime}|${r.isAttended}`).sort()] : [type, 0, 0];
  }));
}

export function attendanceRowsChanged(before: AttRow[], after: AttRow[]) {
  const checksums = new Map(before.map((r) => [rowSubId(r), computeSubjectRowChecksum(r)]));
  return before.length !== after.length || after.some((r) => checksums.get(rowSubId(r)) !== computeSubjectRowChecksum(r));
}

/** Automatic reads follow overview changes; manual batches explicitly recheck history. */
export async function syncAttendanceDetails({
  session, rows, base, isCurrent = () => true, onDetail, onProgress, checkedDetails,
}: {
  session: Session;
  rows: AttRow[];
  base: { registrationid?: string | null; registrationcode?: string | null };
  isCurrent?: () => boolean;
  onDetail?: (id: string, data: Detail) => void;
  onProgress?: (pending: Set<string>, done: number, total: number) => void;
  /** Present only for a manual batch: skip successful reads from its failed attempt. */
  checkedDetails?: Map<string, Detail>;
}) {
  const queue = rows.map((row) => ({
    row,
    key: getSubjectCacheKey(session.username, base.registrationid, row, session.instituteid),
    entry: getCachedSubjectDetailEntry(
      session.username, base.registrationid, row, session.instituteid,
    ),
  })).filter(({ row, key, entry }) => doesSubjectNeedDeepFetch(
    row, entry.data, entry.updatedAt, entry.checksum,
  ) || (checkedDetails && checkedDetails.get(key) !== entry.data));
  const total = queue.length;
  const pending = new Set(queue.map(({ row }) => rowSubId(row)));
  let done = 0;
  let changed = false;
  let cancelled = false;
  const errors: unknown[] = [];
  const progress = () => { if (isCurrent()) onProgress?.(new Set(pending), done, total); };
  progress();
  await Promise.all(Array.from({ length: Math.min(2, total) }, async () => {
    while (queue.length && !cancelled) {
      if (!isCurrent()) { cancelled = true; break; }
      const { row, key, entry } = queue.shift()!;
      const id = rowSubId(row);
      try {
        // A sheet may have loaded this queued subject while other workers were
        // busy. Recheck at dequeue time, not just when the batch was created.
        const latest = getCachedSubjectDetailEntry(session.username, base.registrationid, row, session.instituteid);
        const needsRead = doesSubjectNeedDeepFetch(row, latest.data, latest.updatedAt, latest.checksum) ||
          (checkedDetails && checkedDetails.get(key) !== latest.data && latest.data === entry.data);
        const result = needsRead ? await refreshSubjectDetail(session, row, base) : { data: latest.data! };
        if (!isCurrent()) { cancelled = true; break; }
        changed ||= detailSignature(entry.data) !== detailSignature(result.data);
        checkedDetails?.set(key, result.data);
        onDetail?.(id, result.data);
      } catch (error) {
        errors.push(error);
        const e = error as { code?: string; status?: number };
        if (e.code === "SESSION_EXPIRED" || e.status === 401) cancelled = true;
      } finally {
        pending.delete(id);
        done++;
        progress();
      }
    }
  }));
  const complete = isCurrent() && !cancelled && errors.length === 0 && done === total;
  if (complete) {
    try {
      localStorage.setItem("juet.portal.last_sync", String(Date.now()));
      window.dispatchEvent(new CustomEvent("juet:sync"));
    } catch {}
  }
  return { changed, errors, complete };
}

/** A failed/cancelled batch keeps successful cache writes, but spends no quota. */
export async function runManualAttendanceRefresh({
  readOverview, baselineRows, checkpoint = { details: new Map() }, ...sync
}: Omit<Parameters<typeof syncAttendanceDetails>[0], "rows" | "base" | "checkedDetails"> & {
  readOverview: () => Promise<AttData>;
  baselineRows: AttRow[];
  checkpoint?: ManualAttendanceRefreshCheckpoint;
}) {
  const current = sync.isCurrent ?? (() => true);
  const portalDay = getPortalDayKey();
  if (checkpoint.portalDay !== portalDay) {
    checkpoint.details.clear();
    checkpoint.changed = false;
    checkpoint.portalDay = portalDay;
  }
  const fresh = await readOverview();
  if (!current()) return null;
  const semester = fresh?.semesters?.[0];
  if (!fresh?.rows?.length || !semester?.registrationid) throw new Error("Portal returned no attendance records");
  checkpoint.changed ||= attendanceRowsChanged(baselineRows, fresh.rows);
  const result = await syncAttendanceDetails({
    ...sync, rows: fresh.rows,
    base: { registrationid: semester.registrationid, registrationcode: semester.registrationcode },
    checkedDetails: checkpoint.details,
  });
  checkpoint.changed ||= result.changed;
  if (!current()) return null;
  if (!result.complete) throw result.errors[0] ?? new Error("Attendance refresh did not finish. Please try again.");
  const changed = Boolean(checkpoint.changed);
  const quota = recordSuccessfulManualRefresh(sync.session, { changed });
  checkpoint.details.clear();
  checkpoint.changed = false;
  return { changed, quota };
}
