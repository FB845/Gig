import { Action, ActionPanel, Color, Icon, List, Toast, showToast } from "@raycast/api";
import { LogShiftForm, PlanBlockForm } from "./forms";
import { DOW, PLATFORM_COLOR, PLATFORM_NAME, TYPE_JP, dowOf, money, money0 } from "./lib/format";
import { appUrl, useGig } from "./lib/gig";
import { summarize } from "./lib/summary";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function Command() {
  const { store, loading, error, refresh, mutate } = useGig();

  const common = (
    <>
      <Action.Push title="Log Shift" icon={Icon.Plus} target={<LogShiftForm />} shortcut={{ modifiers: ["cmd"], key: "n" }} />
      <Action.Push title="Plan Block" icon={Icon.Calendar} target={<PlanBlockForm />} shortcut={{ modifiers: ["cmd"], key: "p" }} />
      <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={refresh} shortcut={{ modifiers: ["cmd"], key: "r" }} />
      <Action.OpenInBrowser title="Open Gig Tracker" url={appUrl()} shortcut={{ modifiers: ["cmd"], key: "o" }} />
    </>
  );

  if (error || !store) {
    return (
      <List isLoading={loading}>
        <List.EmptyView icon={Icon.Warning} title="Can’t reach your Gig Tracker data" description={error || "Add your connection key in the extension preferences."} />
      </List>
    );
  }

  const s = summarize(store);
  const row = (title: string, value: string, icon: any, color?: Color) => (
    <List.Item key={title} title={title} icon={{ source: icon, tintColor: color }} accessories={[{ text: value }]} actions={<ActionPanel>{common}</ActionPanel>} />
  );

  return (
    <List isLoading={loading} navigationTitle="Today & This Week">
      <List.Section title="本日 Today" subtitle={s.hit ? "Hit ✓" : `${money0(s.toGo)} to go`}>
        {row("Earned", `${money(s.earned)} of ${money0(s.daily)}`, Icon.Coins, s.hit ? Color.Green : undefined)}
        {s.plannedToday > 0 ? row("Still planned today", `+${money0(s.plannedToday)} → ${money0(s.earned + s.plannedToday)}`, Icon.Calendar, Color.Blue) : null}
        {s.todaysPlans.map((p: any) => {
          const logged = store.planLogged(p);
          return (
            <List.Item
              key={p.id}
              icon={{ source: logged ? Icon.CheckCircle : Icon.Circle, tintColor: PLATFORM_COLOR[p.platform] }}
              title={p.startTime ? `${p.startTime}–${p.endTime}` : "Anytime"}
              subtitle={`${p.platform === "income" ? p.source || "Income" : PLATFORM_NAME[p.platform]}${p.tag ? ` · ${TYPE_JP[p.tag]}` : ""}`}
              accessories={[{ tag: logged ? { value: "Logged", color: Color.Green } : { value: "Planned", color: Color.Blue } }, { text: `${money0(p.estimate)} est` }]}
              actions={
                <ActionPanel>
                  {!logged ? <Action.Push title="Log It" icon={Icon.Check} target={<LogShiftForm planId={p.id} />} /> : null}
                  <Action
                    title="Delete Plan"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    onAction={async () => {
                      await mutate((st: any) => st.deletePlan(p.id));
                      await showToast({ style: Toast.Style.Success, title: "Plan deleted" });
                    }}
                  />
                  {common}
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
      <List.Section title="今週 This week" subtitle={s.weekLine}>
        {row("Goal", money0(s.wk.goal), Icon.Flag)}
        {row("Earned", money0(s.wk.earned), Icon.Coins)}
        {row("Planned (still to come)", money0(s.wk.planned), Icon.Calendar, Color.Blue)}
        {s.wk.met ? row("Days off earned", String(s.wk.daysOff), Icon.CheckCircle, Color.Green) : row("Still to plan", money0(s.wk.shortfall), Icon.ExclamationMark, s.wk.shortfall ? Color.Orange : Color.Green)}
      </List.Section>
      {s.camp.started ? (
        <List.Section title="キャンペーン Campaign 350" subtitle={`${s.camp.daysRemaining} days left`}>
          {row("Earned to date", `${money0(s.camp.earnedToDate)} of ${money0(s.camp.totalGoal)}`, Icon.Coins)}
          {row(s.camp.ahead >= 0 ? "Ahead of pace" : "Behind pace", `${s.camp.ahead >= 0 ? "+" : ""}${money0(s.camp.ahead)}`, s.camp.ahead >= 0 ? Icon.ArrowUp : Icon.ArrowDown, s.camp.ahead >= 0 ? Color.Green : Color.Red)}
          {row("Needed per day", money0(s.camp.requiredPace), Icon.Gauge, s.camp.behindPace ? Color.Red : undefined)}
          {row("Streak", `${s.camp.streak} day${s.camp.streak === 1 ? "" : "s"} at $350+`, Icon.Bolt)}
        </List.Section>
      ) : null}
      <List.Section title="次 Coming up">
        {s.upcoming
          .filter((p: any) => p.date !== s.today)
          .map((p: any) => (
            <List.Item
              key={p.id}
              icon={{ source: Icon.Clock, tintColor: PLATFORM_COLOR[p.platform] }}
              title={`${DOW[dowOf(p.date)]} ${p.startTime ? `${p.startTime}–${p.endTime}` : "anytime"}`}
              subtitle={p.platform === "income" ? p.source || "Income" : PLATFORM_NAME[p.platform]}
              accessories={[{ text: `${money0(p.estimate)} est` }]}
              actions={<ActionPanel>{common}</ActionPanel>}
            />
          ))}
      </List.Section>
    </List>
  );
}
