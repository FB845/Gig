import { LocalStorage, getPreferenceValues } from "@raycast/api";
import { useCallback, useEffect, useState } from "react";
import { createCloud, type Cloud } from "./cloud.js";

export interface Prefs {
  connectionKey: string;
  appUrl?: string;
}

const storage = {
  get: async (k: string) => (await LocalStorage.getItem<string>(k)) ?? undefined,
  set: (k: string, v: string) => LocalStorage.setItem(k, v),
};

let cloud: Cloud | null = null;
export function getCloud(): Cloud {
  if (!cloud) cloud = createCloud({ key: getPreferenceValues<Prefs>().connectionKey, storage, deviceId: "raycast" });
  return cloud;
}

export function appUrl(view = ""): string {
  const base = (getPreferenceValues<Prefs>().appUrl || "https://fb845.github.io/Gig/").replace(/#.*$/, "");
  return view ? `${base}#${view}` : base;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Your synced data: renders from cache at once, then refreshes from the cloud. */
export function useGig() {
  const [rev, setRev] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [lastSync, setLastSync] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getCloud().pull();
      setLastSync(r.lastSync);
      setError(undefined);
    } catch (e) {
      setError(errText(e));
    } finally {
      setRev((x) => x + 1);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = getCloud();
        const o = await c.open();
        if (!alive) return;
        setLastSync(o.lastSync);
        setRev((x) => x + 1);
      } catch (e) {
        if (alive) {
          setError(errText(e));
          setLoading(false);
        }
        return;
      }
      if (alive) await refresh();
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  const mutate = useCallback(async <T,>(fn: (s: Store) => T): Promise<T> => {
    const r = await getCloud().mutate(fn);
    setRev((x) => x + 1);
    return r.result;
  }, []);

  return { store: getCloudSafe()?.store as Store, loading, error, refresh, mutate, rev, lastSync };
}

function getCloudSafe(): Cloud | null {
  try {
    return getCloud();
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Store = any;
