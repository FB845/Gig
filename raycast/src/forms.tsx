import { Action, ActionPanel, Form, Icon, Toast, popToRoot, showToast } from "@raycast/api";
import { useMemo, useState } from "react";
import { HHMM, PLATFORM_NAME, TYPE_JP, fmtHM, money, money0, normTime } from "./lib/format";
import { useGig, type Store } from "./lib/gig";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Plan = any;

const num = (v: string | undefined) => {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const iso = (s: Store, d: Date | null | undefined) => (d ? s.isoDate(d) : s.todayISO());
const dateOf = (isoDate: string) => new Date(isoDate + "T00:00:00");

// ---------------------------------------------------------------------------
// Log Shift (or income) — optionally from a plan ("Log it")
// ---------------------------------------------------------------------------
export function LogShiftForm({ planId }: { planId?: string }) {
  const { store, mutate, loading } = useGig();
  const plan: Plan | undefined = planId && store ? store.getPlans().find((p: Plan) => p.id === planId) : undefined;
  const [platform, setPlatform] = useState<string>(plan?.platform || "flex");
  const [start, setStart] = useState<string>(plan?.startTime || "");
  const [end, setEnd] = useState<string>(plan?.endTime || "");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const income = platform === "income";
  const span = HHMM.test(normTime(start)) && HHMM.test(normTime(end)) && store ? store.hoursBetween(normTime(start), normTime(end)) : 0;

  async function submit(v: Record<string, any>) {
    const s = normTime(v.start), e = normTime(v.end);
    const errs: Record<string, string> = {};
    if ((v.start && !s) || (v.end && !e)) errs.end = "Use HH:MM, e.g. 17:30";
    if ((s && !e) || (!s && e)) errs.end = "Give both start and finish (or neither)";
    if (s && e && s === e) errs.end = "Start and finish must differ";
    if (!income && !s && !num(v.hours)) errs.hours = "Hours worked (or start + finish)";
    if (income && !num(v.amount)) errs.amount = "How much?";
    if (!income && !num(v.gross) && !num(v.tips)) errs.gross = "Base pay or tips";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const toast = await showToast({ style: Toast.Style.Animated, title: "Saving…" });
    try {
      const saved = await mutate((st: Store) => {
        const date = iso(st, v.date);
        const hours = s && e ? st.hoursBetween(s, e) : num(v.hours);
        let rec;
        if (income) {
          rec = st.addIncome({ date, source: v.source || "Income", payType: "flat", amount: num(v.amount), startTime: s, endTime: e, hours, note: v.notes || "" });
        } else {
          rec = st.addShift({
            platform, date, startTime: s, endTime: e, hours,
            gross: num(v.gross), tips: num(v.tips), miles: num(v.miles), jobs: num(v.jobs), mpg: num(v.mpg),
            tag: platform === "flex" ? v.tag || "" : "", scheduledHours: platform === "flex" ? num(v.scheduled) : 0,
            notes: v.notes || "",
          });
        }
        if (planId) st.markPlanLogged(planId, income ? "income" : "shift", rec.id);
        return income ? num(v.amount) : st.shiftIncome(rec);
      });
      toast.style = Toast.Style.Success;
      toast.title = `Logged ${money(saved)}`;
      await popToRoot();
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = "Couldn’t save";
      toast.message = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <Form
      isLoading={loading}
      navigationTitle={plan ? "Log Planned Block" : "Log Shift"}
      actions={
        <ActionPanel>
          <Action.SubmitForm title={income ? "Save Income" : "Save Shift"} icon={Icon.Check} onSubmit={submit} />
        </ActionPanel>
      }
    >
      {plan ? <Form.Description title="From plan" text={`${plan.date} ${plan.startTime || "anytime"}–${plan.endTime || ""} · est ${money0(plan.estimate)} — set what you actually made`} /> : null}
      <Form.Dropdown id="platform" title="Platform 事業者" value={platform} onChange={setPlatform}>
        <Form.Dropdown.Item value="flex" title="Amazon Flex" />
        <Form.Dropdown.Item value="doordash" title="DoorDash" />
        <Form.Dropdown.Item value="other" title="Other gig" />
        <Form.Dropdown.Item value="income" title="収入 Income (e.g. TraceHaus)" />
      </Form.Dropdown>
      <Form.DatePicker id="date" title="Date 日付" type={Form.DatePicker.Type.Date} defaultValue={plan ? dateOf(plan.date) : new Date()} />
      <Form.TextField id="start" title="Start 発" placeholder="06:00" value={start} onChange={setStart} />
      <Form.TextField id="end" title="Finish 着" placeholder="09:30" value={end} onChange={setEnd} error={errors.end} info={span ? `= ${fmtHM(span)}` : undefined} />
      {!start && !end && !income ? <Form.TextField id="hours" title="Hours (no times)" placeholder="3.5" error={errors.hours} /> : null}
      {income ? (
        <>
          <Form.TextField id="source" title="Source 取引先" placeholder="TraceHaus" defaultValue={plan?.source || ""} />
          <Form.TextField id="amount" title="Amount 金額 $" placeholder="500" defaultValue={plan?.estimate ? String(plan.estimate) : ""} error={errors.amount} />
        </>
      ) : (
        <>
          <Form.TextField id="gross" title="Base pay 基本給 $" placeholder="84.00" defaultValue={plan?.estimate ? String(plan.estimate) : ""} error={errors.gross} />
          <Form.TextField id="tips" title="Tips チップ $" placeholder="0" />
          <Form.TextField id="miles" title="Miles 走行距離" placeholder="34.5" />
          <Form.TextField id="jobs" title="Deliveries 配達数" placeholder="12" />
          <Form.TextField id="mpg" title="MPG 燃費" placeholder="blank = Settings default" info="Fuel cost is added automatically from miles ÷ MPG × your fuel price." />
        </>
      )}
      {platform === "flex" ? (
        <>
          <Form.Dropdown id="tag" title="Block type 種別" defaultValue={plan?.tag || ""}>
            <Form.Dropdown.Item value="" title="—" />
            {Object.entries(TYPE_JP).map(([k, jp]) => (
              <Form.Dropdown.Item key={k} value={k} title={`${jp} ${k}`} />
            ))}
          </Form.Dropdown>
          <Form.TextField id="scheduled" title="Block length (h)" placeholder="3.5" defaultValue={plan?.hours ? String(plan.hours) : ""} />
        </>
      ) : null}
      <Form.TextArea id="notes" title="Notes メモ" defaultValue={plan?.note || ""} />
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Plan Block — estimate pre-filled from your best-hours history
// ---------------------------------------------------------------------------
export function PlanBlockForm(props: { date?: string; start?: string; end?: string; platform?: string }) {
  const { store, mutate, loading } = useGig();
  const [date, setDate] = useState<Date | null>(props.date ? dateOf(props.date) : new Date());
  const [start, setStart] = useState(props.start || "17:00");
  const [end, setEnd] = useState(props.end || "21:00");
  const [platform, setPlatform] = useState(props.platform || "doordash");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const s = normTime(start), e = normTime(end);

  const hint = useMemo(() => {
    if (!store || !s || !e || s === e) return null;
    const d = iso(store, date);
    const est = platform === "income" ? null : store.estimateFor({ date: d, startTime: s, endTime: e, platform });
    const clash = store.planOverlaps({ date: d, startTime: s, endTime: e });
    const wk = store.deskWeek(store.isoDate(store.startOfWeek(dateOf(d))));
    return { est, clash, wk, hours: store.hoursBetween(s, e) };
  }, [store, date, s, e, platform]);

  async function submit(v: Record<string, any>) {
    const errs: Record<string, string> = {};
    if (platform !== "income" && (!s || !e)) errs.end = "Use HH:MM, e.g. 17:00 and 21:00";
    if (s && e && s === e) errs.end = "Start and finish must differ";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const estimate = num(v.estimate) || (hint?.est ? hint.est.estimate : 0);
    try {
      await mutate((st: Store) => st.addPlan({
        date: iso(st, date), platform, startTime: s, endTime: e, estimate,
        tag: platform === "flex" ? v.tag || "" : "", source: platform === "income" ? v.source || "" : "", note: v.note || "",
      }));
      await showToast({ style: Toast.Style.Success, title: `Planned ${s}–${e} · ${money0(estimate)} est` });
      await popToRoot();
    } catch (err) {
      await showToast({ style: Toast.Style.Failure, title: "Couldn’t save", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <Form
      isLoading={loading}
      navigationTitle="Plan Block"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Plan" icon={Icon.Calendar} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="platform" title="Platform 事業者" value={platform} onChange={setPlatform}>
        <Form.Dropdown.Item value="doordash" title="DoorDash" />
        <Form.Dropdown.Item value="flex" title="Amazon Flex" />
        <Form.Dropdown.Item value="other" title="Other gig" />
        <Form.Dropdown.Item value="income" title="収入 Income" />
      </Form.Dropdown>
      <Form.DatePicker id="date" title="Date 日付" type={Form.DatePicker.Type.Date} value={date} onChange={setDate} />
      <Form.TextField id="start" title="Start 発" value={start} onChange={setStart} placeholder="17:00" />
      <Form.TextField id="end" title="Finish 着" value={end} onChange={setEnd} placeholder="21:00" error={errors.end} info={hint ? `= ${fmtHM(hint.hours)}` : undefined} />
      {platform === "flex" ? (
        <Form.Dropdown id="tag" title="Block type 種別" defaultValue="">
          <Form.Dropdown.Item value="" title="—" />
          {Object.entries(TYPE_JP).map(([k, jp]) => (
            <Form.Dropdown.Item key={k} value={k} title={`${jp} ${k}`} />
          ))}
        </Form.Dropdown>
      ) : null}
      {platform === "income" ? <Form.TextField id="source" title="Source 取引先" placeholder="TraceHaus" /> : null}
      <Form.TextField
        id="estimate"
        title="Estimate 見込 $"
        placeholder={hint?.est ? String(hint.est.estimate) : "0"}
        info="Leave blank to use the suggested estimate."
      />
      {hint?.est ? (
        <Form.Description
          title="Suggested"
          text={`${money0(hint.est.estimate)} — ${money(hint.est.rate)}/hr ${hint.est.fromSlot ? `from your ${PLATFORM_NAME[platform]} history in this slot` : "(your overall average — no history in this slot yet)"}`}
        />
      ) : null}
      {hint?.clash?.length ? <Form.Description title="⚠ Overlaps" text={hint.clash.map((p: Plan) => `${p.startTime}–${p.endTime} ${PLATFORM_NAME[p.platform] || p.source}`).join(", ")} /> : null}
      {hint ? (
        <Form.Description
          title="This week"
          text={`${money0(hint.wk.projected)} planned+earned of ${money0(hint.wk.goal)}${hint.wk.shortfall ? ` — ${money0(hint.wk.shortfall)} short before this block` : " — goal covered"}`}
        />
      ) : null}
      <Form.TextField id="note" title="Note メモ" placeholder="Surge zone, pick up at 9" />
    </Form>
  );
}
