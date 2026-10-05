import { Action, ActionPanel, Color, Icon, List, Toast, showToast } from "@raycast/api";
import { useState } from "react";
import { LogShiftForm, PlanBlockForm } from "./forms";
import { DOW, PLATFORM_COLOR, PLATFORM_NAME, TYPE_JP, dayLabel, dowOf, money, money0 } from "./lib/format";
import { appUrl, useGig, type Store } from "./lib/gig";

/* eslint-disable @typescript-eslint/no-explicit-any */
const addDays = (s: Store, iso: string, n: number) => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return s.isoDate(d);
};

export default function Command() {
  const { store, loading, error, refresh, mutate } = useGig();
  const [offset, setOffset] = useState("0");

  if (error || !store) {
    return (
      <List isLoading={loading}>
        <List.EmptyView icon={Icon.Warning} title="Can’t reach your Gig Tracker data" description={error || "Add your connection key in the extension preferences."} />
      </List>
    );
  }

  const thisWeek = store.isoDate(store.startOfWeek(new Date()));
  const start = addDays(store, thisWeek, 7 * Number(offset));
  const wk = store.deskWeek(start);
  const today = store.todayISO();
  const suggs = wk.end >= today ? store.suggestSlots(start) : [];
  const status = wk.shortfall ? `short ${money0(wk.shortfall)}` : `goal covered${wk.metOn ? ` ${DOW[dowOf(wk.metOn)]}` : ""}`;

  const common = (
    <>
      <Action.Push title="Plan Block" icon={Icon.Calendar} target={<PlanBlockForm />} shortcut={{ modifiers: ["cmd"], key: "p" }} />
      <Action.Push title="Log Shift" icon={Icon.Plus} target={<LogShiftForm />} shortcut={{ modifiers: ["cmd"], key: "n" }} />
      <Action.OpenInBrowser title="Open Planning Desk" url={appUrl("desk")} shortcut={{ modifiers: ["cmd"], key: "o" }} />
      <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={refresh} shortcut={{ modifiers: ["cmd"], key: "r" }} />
    </>
  );

  // Everything on each day: open plans, logged shifts and income.
  const byDay = new Map<string, any[]>(wk.dates.map((d: string) => [d, []]));
  for (const p of store.getPlans()) if (byDay.has(p.date) && !store.planLogged(p)) byDay.get(p.date)!.push({ kind: "plan", rec: p, platform: p.platform, start: p.startTime, end: p.endTime, amount: p.estimate, name: p.platform === "income" ? p.source || "Income" : PLATFORM_NAME[p.platform], tag: p.tag });
  for (const x of store.getShifts()) if (byDay.has(x.date)) byDay.get(x.date)!.push({ kind: "shift", rec: x, platform: x.platform, start: x.startTime, end: x.endTime, amount: store.shiftIncome(x), name: PLATFORM_NAME[x.platform], tag: x.tag, hours: x.hours });
  for (const x of store.getIncomes()) if (byDay.has(x.date)) byDay.get(x.date)!.push({ kind: "income", rec: x, platform: "income", start: x.startTime, end: x.endTime, amount: x.amount, name: x.source || "Income" });

  return (
    <List
      isLoading={loading}
      navigationTitle="Week Plan"
      searchBarPlaceholder={`${wk.dates[0].slice(5)} – ${wk.end.slice(5)} · ${money0(wk.projected)} of ${money0(wk.goal)} · ${status}`}
      searchBarAccessory={
        <List.Dropdown tooltip="Week" value={offset} onChange={setOffset}>
          <List.Dropdown.Item value="-1" title="Last week" />
          <List.Dropdown.Item value="0" title="This week" />
          <List.Dropdown.Item value="1" title="Next week" />
          <List.Dropdown.Item value="2" title="In 2 weeks" />
        </List.Dropdown>
      }
    >
      <List.Section title="週間目標 Weekly goal" subtitle={status}>
        <List.Item
          title={`${money0(wk.projected)} of ${money0(wk.goal)}`}
          subtitle={`${money0(wk.earned)} earned · ${money0(wk.planned)} planned · ${wk.hours.toFixed(1)} h`}
          icon={{ source: wk.shortfall ? Icon.ExclamationMark : Icon.CheckCircle, tintColor: wk.shortfall ? Color.Orange : Color.Green }}
          accessories={wk.daysOff.length ? [{ tag: { value: `${wk.daysOff.map((d: string) => DOW[dowOf(d)]).join(" & ")} off`, color: Color.Green } }] : []}
          actions={<ActionPanel>{common}</ActionPanel>}
        />
      </List.Section>

      {suggs.length ? (
        <List.Section title="隙間埋め Fill the gap" subtitle="best open slots from your last 90 days">
          {suggs.map((sg: any, i: number) => (
            <List.Item
              key={`s${i}`}
              icon={{ source: Icon.PlusCircle, tintColor: Color.Blue }}
              title={`${DOW[dowOf(sg.date)]} ${sg.startTime}–${sg.endTime}`}
              subtitle={`${PLATFORM_NAME[sg.platform]} · ${money(sg.rate)}/hr · ${sg.shifts} past shifts`}
              accessories={[...(sg.freeDay ? [{ tag: { value: "free day", color: Color.Yellow } }] : []), { text: `+${money0(sg.estimate)}` }]}
              actions={
                <ActionPanel>
                  <Action
                    title="Add to Plan"
                    icon={Icon.Plus}
                    onAction={async () => {
                      await mutate((st: any) => st.addPlan({ date: sg.date, platform: sg.platform, startTime: sg.startTime, endTime: sg.endTime, estimate: sg.estimate }));
                      await showToast({ style: Toast.Style.Success, title: `Planned ${DOW[dowOf(sg.date)]} ${sg.startTime}–${sg.endTime}`, message: `+${money0(sg.estimate)}` });
                    }}
                  />
                  <Action.Push title="Adjust and Plan…" icon={Icon.Pencil} target={<PlanBlockForm date={sg.date} start={sg.startTime} end={sg.endTime} platform={sg.platform} />} />
                  {common}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : null}

      {wk.days.map((day: any) => {
        const items = (byDay.get(day.date) || []).sort((a, b) => (a.start || "99").localeCompare(b.start || "99"));
        return (
          <List.Section
            key={day.date}
            title={`${dayLabel(day.date)}${day.date === today ? " · 今日 Today" : ""}`}
            subtitle={day.total ? `${money0(day.total)}${day.total >= store.CAMPAIGN.daily ? " ✓" : ""}${wk.daysOff.includes(day.date) ? " · 休 day off" : ""}` : wk.daysOff.includes(day.date) ? "休 day off" : "—"}
          >
            {items.map((it: any) => {
              const plan = it.kind === "plan";
              return (
                <List.Item
                  key={`${it.kind}-${it.rec.id}`}
                  icon={{ source: plan ? Icon.Circle : Icon.CheckCircle, tintColor: PLATFORM_COLOR[it.platform] }}
                  title={it.start ? `${it.start}–${it.end}` : plan ? "Anytime" : `${(it.hours || 0).toFixed(1)} h`}
                  subtitle={`${it.name}${it.tag ? ` · ${TYPE_JP[it.tag]}` : ""}`}
                  accessories={[{ tag: plan ? { value: day.date < today ? "Missed" : "Planned", color: day.date < today ? Color.Red : Color.Blue } : { value: "Logged", color: Color.Green } }, { text: plan ? `${money0(it.amount)} est` : money(it.amount) }]}
                  actions={
                    <ActionPanel>
                      {plan ? <Action.Push title="Log It" icon={Icon.Check} target={<LogShiftForm planId={it.rec.id} />} /> : null}
                      {plan ? (
                        <Action
                          title="Delete Plan"
                          icon={Icon.Trash}
                          style={Action.Style.Destructive}
                          shortcut={{ modifiers: ["ctrl"], key: "x" }}
                          onAction={async () => {
                            await mutate((st: any) => st.deletePlan(it.rec.id));
                            await showToast({ style: Toast.Style.Success, title: "Plan deleted" });
                          }}
                        />
                      ) : null}
                      {common}
                    </ActionPanel>
                  }
                />
              );
            })}
          </List.Section>
        );
      })}
    </List>
  );
}
