/**
 * Builds an iCalendar file (RFC 5545) in the browser, so deadlines can be added to Outlook, Google Calendar
 * or Apple Calendar. Nothing is sent anywhere; the file is made from data already on screen.
 */
export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO date-time. */
  at: string;
  description?: string;
  url?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 20261210T120000Z */
function stamp(iso: string | number): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Escape text and fold lines at 75 octets, as the format requires. */
function line(name: string, value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/([,;])/g, "\\$1");
  const full = `${name}:${escaped}`;
  const parts: string[] = [];
  for (let i = 0; i < full.length; i += 73) parts.push((i === 0 ? "" : " ") + full.slice(i, i + 73));
  return parts.join("\r\n");
}

export function buildCalendar(events: CalendarEvent[], now = Date.now()): string {
  const body = events.flatMap((event) => [
    "BEGIN:VEVENT",
    `UID:${event.id}@tenderline`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(event.at)}`,
    `DTEND:${stamp(new Date(event.at).getTime() + 30 * 60_000)}`,
    line("SUMMARY", event.title),
    ...(event.description ? [line("DESCRIPTION", event.description)] : []),
    ...(event.url ? [line("URL", event.url)] : []),
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    line("DESCRIPTION", event.title),
    "TRIGGER:-PT1H",
    "END:VALARM",
    "END:VEVENT",
  ]);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tenderline//Deadlines//EN", "CALSCALE:GREGORIAN", ...body, "END:VCALENDAR"].join("\r\n") + "\r\n";
}

export function downloadCalendar(filename: string, events: CalendarEvent[]): void {
  const blob = new Blob([buildCalendar(events)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
