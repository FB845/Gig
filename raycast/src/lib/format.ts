export const money0 = (n: number) => (n < 0 ? "−$" : "$") + Math.round(Math.abs(n)).toLocaleString("en-US");
export const money = (n: number) =>
  (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const DOW_JP = ["日", "月", "火", "水", "木", "金", "土"];
export const dowOf = (iso: string) => new Date(iso + "T00:00:00").getDay();
export const md = (iso: string) => {
  const [, m, d] = iso.split("-").map(Number);
  return `${m}/${d}`;
};
export const dayLabel = (iso: string) => `${DOW_JP[dowOf(iso)]} ${DOW[dowOf(iso)]} ${md(iso)}`;

export const PLATFORM_NAME: Record<string, string> = {
  flex: "Amazon Flex",
  doordash: "DoorDash",
  other: "Other",
  income: "Income",
};
// Matches the app's platform colours.
export const PLATFORM_COLOR: Record<string, string> = {
  flex: "#6aa8ff",
  doordash: "#ff6b5f",
  other: "#a78bfa",
  income: "#e8f1ff",
};
export const TYPE_JP: Record<string, string> = { Local: "普通", Rapid: "快速", Express: "急行", "Rapid Express": "特急" };

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** "9:5" / "930" / "09:30" → "09:30" (or "" if it can't be read). */
export function normTime(t: string): string {
  const s = (t || "").trim();
  if (!s) return "";
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return "";
  const h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (h > 23 || min > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
export const nowHHMM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export const fmtHM = (h: number) => `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}m`;
