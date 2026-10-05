import { Color, Icon, LaunchType, MenuBarExtra, launchCommand, open, openExtensionPreferences } from "@raycast/api";
import { DOW, dowOf, money0, PLATFORM_NAME } from "./lib/format";
import { appUrl, useGig } from "./lib/gig";
import { summarize } from "./lib/summary";

/* eslint-disable @typescript-eslint/no-explicit-any */
const go = (name: string, launchContext?: Record<string, unknown>) =>
  launchCommand({ name, type: LaunchType.UserInitiated, ...(launchContext ? { context: launchContext } : {}) });

export default function Command() {
  const { store, loading, error, refresh, lastSync } = useGig();

  if (error || !store) {
    return (
      <MenuBarExtra icon={Icon.Train} title="350" isLoading={loading} tooltip="Gig Tracker">
        <MenuBarExtra.Item icon={Icon.Warning} title={error || "Add your connection key"} />
        <MenuBarExtra.Item title="Open Preferences…" onAction={openExtensionPreferences} />
        <MenuBarExtra.Item title="Retry" icon={Icon.ArrowClockwise} onAction={refresh} />
      </MenuBarExtra>
    );
  }

  const s = summarize(store);
  const title = s.hit ? `✓ ${money0(s.earned)}` : `${money0(s.earned)} / ${money0(s.daily)}`;
  const synced = lastSync ? new Date(lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "never";

  return (
    <MenuBarExtra
      icon={{ source: Icon.Train, tintColor: s.hit ? Color.Green : undefined }}
      title={title}
      isLoading={loading}
      tooltip={`Gig Tracker · today ${money0(s.earned)} of ${money0(s.daily)}`}
    >
      <MenuBarExtra.Section title="本日 Today">
        <MenuBarExtra.Item title={`Earned ${money0(s.earned)} of ${money0(s.daily)}`} icon={{ source: Icon.Coins, tintColor: s.hit ? Color.Green : Color.PrimaryText }} onAction={() => go("today")} />
        {s.plannedToday > 0 ? (
          <MenuBarExtra.Item title={`Planned +${money0(s.plannedToday)} → ${money0(s.earned + s.plannedToday)}`} icon={Icon.Calendar} onAction={() => go("week")} />
        ) : null}
        <MenuBarExtra.Item title={s.hit ? `Hit ✓ ${s.earned > s.daily ? `+${money0(s.earned - s.daily)} over` : ""}` : `${money0(s.toGo)} to go`} icon={s.hit ? Icon.CheckCircle : Icon.Circle} />
      </MenuBarExtra.Section>

      <MenuBarExtra.Section title="今週 This week">
        <MenuBarExtra.Item title={`${money0(s.wk.earned)} earned + ${money0(s.wk.planned)} planned / ${money0(s.wk.goal)}`} icon={Icon.BarChart} onAction={() => go("week")} />
        <MenuBarExtra.Item title={s.weekLine} icon={s.wk.met || s.wk.projMet ? Icon.CheckCircle : Icon.ExclamationMark} onAction={() => go("week")} />
      </MenuBarExtra.Section>

      {s.upcoming.length ? (
        <MenuBarExtra.Section title="次 Next">
          {s.upcoming.slice(0, 3).map((p: any) => (
            <MenuBarExtra.Item
              key={p.id}
              icon={Icon.Clock}
              title={`${p.date === s.today ? "Today" : DOW[dowOf(p.date)]} ${p.startTime ? `${p.startTime}–${p.endTime}` : "anytime"} · ${p.platform === "income" ? p.source || "Income" : PLATFORM_NAME[p.platform]}`}
              subtitle={`est ${money0(p.estimate)}`}
              onAction={() => (p.date === s.today ? go("log-shift", { planId: p.id }) : go("week"))}
            />
          ))}
        </MenuBarExtra.Section>
      ) : null}

      {s.camp.started && !s.camp.ended ? (
        <MenuBarExtra.Section title="キャンペーン Campaign 350">
          <MenuBarExtra.Item title={`${money0(s.camp.earnedToDate)} of ${money0(s.camp.totalGoal)} · ${s.camp.daysRemaining} days left`} icon={Icon.Flag} />
          <MenuBarExtra.Item
            title={s.camp.ahead >= 0 ? `Ahead of pace +${money0(s.camp.ahead)}` : `Behind pace ${money0(s.camp.ahead)} · need ${money0(s.camp.requiredPace)}/day`}
            icon={s.camp.ahead >= 0 ? Icon.ArrowUp : Icon.ArrowDown}
          />
        </MenuBarExtra.Section>
      ) : null}

      <MenuBarExtra.Section>
        <MenuBarExtra.Item title="Log Shift…" icon={Icon.Plus} onAction={() => go("log-shift")} />
        <MenuBarExtra.Item title="Plan Block…" icon={Icon.Calendar} onAction={() => go("plan-block")} />
        <MenuBarExtra.Item title="Week Plan" icon={Icon.List} onAction={() => go("week")} />
        <MenuBarExtra.Item title="Open Planning Desk" icon={Icon.Globe} onAction={() => open(appUrl("desk"))} />
        <MenuBarExtra.Item title={`Refresh (synced ${synced})`} icon={Icon.ArrowClockwise} onAction={refresh} />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
