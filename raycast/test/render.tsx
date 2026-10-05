// Render every command with seeded data (no Raycast needed) and check the output.
import { renderToString } from "react-dom/server";
import { store } from "../src/lib/cloud.js";
import MenuBar from "../src/menu-bar";
import Today from "../src/today";
import Week from "../src/week";
import LogShift from "../src/log-shift";
import PlanBlock from "../src/plan-block";

/* eslint-disable @typescript-eslint/no-explicit-any */
const key = "gt1." + Buffer.from(JSON.stringify({ v: 1, k: "demo-key", p: "demo-gig", r: "refresh", e: "me@example.com" })).toString("base64url");
(globalThis as any).__prefs = { connectionKey: key, appUrl: "https://fb845.github.io/Gig/" };

const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return store.isoDate(d); };
store.clearAll();
for (let n = -28; n < 0; n++) {
  store.addShift({ platform: "doordash", date: day(n), startTime: "17:00", endTime: "21:00", hours: 4, gross: 120, miles: 30, mpg: 25 });
  store.addShift({ platform: "flex", date: day(n), startTime: "06:00", endTime: "09:30", hours: 3.5, gross: 90, tag: "Express" });
}
store.addShift({ platform: "flex", date: day(0), startTime: "06:00", endTime: "09:30", hours: 3.5, gross: 96, tag: "Rapid Express" });
store.addIncome({ date: day(0), source: "TraceHaus", amount: 164 });
const p1 = store.addPlan({ date: day(0), platform: "doordash", startTime: "22:00", endTime: "23:30", estimate: 45 });
store.addPlan({ date: day(1), platform: "flex", startTime: "08:00", endTime: "11:30", tag: "Express", estimate: 88 });
store.addPlan({ date: day(2), platform: "income", source: "TraceHaus", estimate: 200 });

let fails = 0;
const check = (name: string, html: string, needles: (string | RegExp)[]) => {
  const miss = needles.filter((n) => (typeof n === "string" ? !html.includes(n) : !n.test(html)));
  console.log(`${miss.length ? "  ✗" : "  ✓"} ${name}${miss.length ? " — missing " + miss.join(", ") : ""}`);
  if (miss.length) fails++;
};
const render = (name: string, el: any) => {
  try { return renderToString(el); } catch (e: any) { console.log(`  ✗ ${name} threw: ${e.stack || e}`); fails++; return ""; }
};

const mb = render("menu bar", <MenuBar />);
check("menu bar: title $260 / $350, today/week/next/campaign sections, actions", mb, ['data-title="$260 / $350"', "本日 Today", "Earned $260 of $350", "$90 to go", "今週 This week", "次 Next", "Log Shift…", "Open Planning Desk"]);
const td = render("today", <Today />);
check("today: earned, today's plan, week + campaign sections", td, ["本日 Today", "$260.00 of $350", "22:00–23:30", "今週 This week", "Planned (still to come)"]);
const wk = render("week", <Week />);
check("week: goal row, fill-the-gap suggestions, day sections with blocks", wk, ["週間目標 Weekly goal", "隙間埋め Fill the gap", /past shifts/, "今日 Today", "06:00–09:30", "Logged", "Planned"]);
const ls = render("log shift", <LogShift launchContext={{ planId: p1.id }} />);
check("log shift (from a plan): prefilled form", ls, ["Log Planned Block", 'data-value="doordash"', 'data-value="22:00"', "est $45", "Base pay"]);
const pb = render("plan block", <PlanBlock launchContext={{ date: day(1), start: "17:00", end: "21:00", platform: "doordash" }} />);
check("plan block: slot estimate from history + week line", pb, [/\$\d+ — \$30\.00\/hr from your DoorDash history in this slot/, "This week"]);
const bad = (globalThis as any).__prefs;
console.log(fails ? `\nRAYCAST RENDER: ${fails} FAILED` : "\nRAYCAST RENDER: ALL PASSED ✓");
process.exit(fails ? 1 : 0);
void bad;
