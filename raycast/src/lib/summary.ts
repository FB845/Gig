import { DOW, dowOf, money0, nowHHMM } from "./format";
import type { Store } from "./gig";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Everything the menu bar and Today views show, from the app's own maths. */
export function summarize(store: Store) {
  const today: string = store.todayISO();
  const daily: number = store.CAMPAIGN.daily;
  const earned: number = store.dailyIncome(today);
  const plannedToday: number = store.trajectory(today, today)[0].planned;
  const wk = store.weeklyGoalStats();
  const camp = store.campaignStats();
  const now = nowHHMM();
  const upcoming = store
    .getPlans()
    .filter((p: any) => !store.planLogged(p) && (p.date > today || (p.date === today && (!p.endTime || p.endTime > now))))
    .slice(0, 5);
  const todaysPlans = store.getPlans().filter((p: any) => p.date === today);
  const toGo = Math.max(0, daily - earned);
  const weekLine = wk.met
    ? `Goal met ${DOW[dowOf(wk.metOn)]}${wk.daysOff ? ` — ${wk.daysOff} day${wk.daysOff === 1 ? "" : "s"} off` : ""}`
    : wk.projMet
      ? `On plan to meet it ${DOW[dowOf(wk.projMetOn)]}${wk.projDaysOff ? ` (+${wk.projDaysOff} off)` : ""}`
      : `Short ${money0(wk.shortfall)} — plan more`;
  return { today, daily, earned, plannedToday, toGo, hit: earned >= daily, wk, camp, upcoming, todaysPlans, weekLine };
}
