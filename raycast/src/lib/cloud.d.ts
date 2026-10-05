// Types for cloud.js (plain JS so the Node sync tests can run it too).
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface KeyInfo { apiKey: string; projectId: string; refreshToken: string; email: string }
export function parseKey(key: string): KeyInfo;
export interface Storage { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> }
export interface Cloud {
  /** The app's data model (js/store.js) holding your synced records. */
  store: any;
  email: string;
  open(): Promise<{ lastSync: number }>;
  pull(): Promise<{ changed: number; lastSync: number }>;
  mutate<T>(fn: (store: any) => T): Promise<{ result: T; written: number }>;
}
export function createCloud(opts: { key: string; storage: Storage; endpoints?: { auth?: string; firestore?: string }; deviceId?: string }): Cloud;
export const store: any;
