/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Connection Key - In the Gig Tracker app: Settings → Cloud sync → Copy Raycast key. */
  "connectionKey": string,
  /** App URL - Where your Gig Tracker app lives. */
  "appUrl": string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `menu-bar` command */
  export type MenuBar = ExtensionPreferences & {}
  /** Preferences accessible in the `today` command */
  export type Today = ExtensionPreferences & {}
  /** Preferences accessible in the `log-shift` command */
  export type LogShift = ExtensionPreferences & {}
  /** Preferences accessible in the `plan-block` command */
  export type PlanBlock = ExtensionPreferences & {}
  /** Preferences accessible in the `week` command */
  export type Week = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `menu-bar` command */
  export type MenuBar = {}
  /** Arguments passed to the `today` command */
  export type Today = {}
  /** Arguments passed to the `log-shift` command */
  export type LogShift = {}
  /** Arguments passed to the `plan-block` command */
  export type PlanBlock = {}
  /** Arguments passed to the `week` command */
  export type Week = {}
}

