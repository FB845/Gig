// A stand-in for @raycast/api that renders every component as plain HTML with
// its props as attributes, so commands can be rendered and checked in Node.
import React from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */
const attrs = (p: any) => {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(p || {})) {
    if (k === "children" || typeof v === "function" || React.isValidElement(v)) continue;
    o[`data-${k.toLowerCase()}`] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return o;
};
const C = (name: string) => {
  const f: any = (p: any) => React.createElement("div", { "data-c": name, ...attrs(p) }, p.children, ...Object.values(p || {}).filter((v) => React.isValidElement(v)) as any[]);
  f.displayName = name;
  return f;
};
const proxy = (prefix: string) => new Proxy({}, { get: (_t, k) => `${prefix}.${String(k)}` });

export const Icon: any = proxy("icon");
export const Color: any = proxy("color");
export const List: any = Object.assign(C("List"), { Section: C("List.Section"), Item: C("List.Item"), EmptyView: C("List.EmptyView"), Dropdown: Object.assign(C("List.Dropdown"), { Item: C("List.Dropdown.Item") }) });
export const MenuBarExtra: any = Object.assign(C("MenuBarExtra"), { Section: C("MenuBarExtra.Section"), Item: C("MenuBarExtra.Item") });
export const Form: any = Object.assign(C("Form"), {
  Dropdown: Object.assign(C("Form.Dropdown"), { Item: C("Form.Dropdown.Item") }),
  DatePicker: Object.assign(C("Form.DatePicker"), { Type: { Date: "date", DateTime: "datetime" } }),
  TextField: C("Form.TextField"), TextArea: C("Form.TextArea"), Description: C("Form.Description"), Checkbox: C("Form.Checkbox"),
});
export const ActionPanel: any = Object.assign(C("ActionPanel"), { Section: C("ActionPanel.Section") });
export const Action: any = Object.assign(C("Action"), { Push: C("Action.Push"), SubmitForm: C("Action.SubmitForm"), OpenInBrowser: C("Action.OpenInBrowser"), Style: { Destructive: "destructive", Regular: "regular" } });
const mem = new Map<string, string>();
export const LocalStorage = { getItem: async (k: string) => mem.get(k), setItem: async (k: string, v: string) => { mem.set(k, v); } };
export const getPreferenceValues = () => (globalThis as any).__prefs;
export const LaunchType = { UserInitiated: "userInitiated", Background: "background" };
export const launchCommand = async () => {};
export const open = async () => {};
export const openExtensionPreferences = async () => {};
export const popToRoot = async () => {};
export const Toast = { Style: { Success: "success", Failure: "failure", Animated: "animated" } };
export const showToast = async (o: any) => ({ ...o });
export type LaunchProps<T = any> = T & { arguments?: any };
