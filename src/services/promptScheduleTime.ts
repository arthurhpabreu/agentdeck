export interface ScheduleTiming { startDate: string; endDate: string; time: string; weekdays: number[]; timezone: string }
const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(at: number, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); formatters.set(timezone, formatter); }
  return Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
}
export function dateInZone(at: number, timezone: string) { const p = parts(at, timezone); return `${p.year}-${p.month}-${p.day}`; }
function validDate(date: string) { return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date; }
export function validScheduleTiming(timing: ScheduleTiming): boolean {
  try {
    parts(Date.now(), timing.timezone);
    return validDate(timing.startDate) && validDate(timing.endDate) && timing.endDate >= timing.startDate
      && Date.parse(timing.endDate) - Date.parse(timing.startDate) <= 3660 * 86_400_000
      && /^([01]\d|2[0-3]):[0-5]\d$/.test(timing.time) && timing.weekdays.length > 0
      && timing.weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6);
  } catch { return false; }
}
/** Resolve wall clock time in the saved IANA zone, independently of this machine's zone.
 * Nonexistent DST times are skipped; a repeated time gets a single occurrence. */
export function scheduleInstant(date: string, time: string, timezone: string): number | undefined {
  const wall = Date.parse(`${date}T${time}:00Z`);
  let candidate = wall;
  for (let i = 0; i < 4; i++) {
    const p = parts(candidate, timezone);
    const shown = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
    const correction = wall - shown;
    if (!correction) return candidate;
    candidate += correction;
  }
  return undefined;
}
export function nextScheduleRun(timing: ScheduleTiming, after: number): number | undefined {
  if (!validScheduleTiming(timing)) return undefined;
  const today = dateInZone(after, timing.timezone);
  const first = timing.startDate > today ? timing.startDate : today;
  for (let day = Date.parse(first); day <= Date.parse(timing.endDate); day += 86_400_000) {
    if (!timing.weekdays.includes(new Date(day).getUTCDay())) continue;
    const date = new Date(day).toISOString().slice(0, 10);
    const instant = scheduleInstant(date, timing.time, timing.timezone);
    if (instant !== undefined && instant > after) return instant;
  }
  return undefined;
}
