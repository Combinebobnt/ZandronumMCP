// Input-event constants mirrored from the engine headers, plus the mapping from
// friendly menu-key names to the GUI key event the menu system responds to.
//
//   d_event.h  EGenericEvent: EV_GUI_Event = 4
//   d_gui.h    EGUIEvent:     EV_GUI_KeyDown = 1
//   d_gui.h    GK_* codes:    LEFT=5 RIGHT=6 BACKSPACE=8 DOWN=10 UP=11 RETURN=13 ESCAPE=27
//
// Menus read EV_GUI_Event/EV_GUI_KeyDown (not raw EV_KeyDown), so these are the
// events that actually move a menu cursor.

export const EV_GUI_EVENT = 4;
export const EV_GUI_KEYDOWN = 1;
export const EV_GUI_KEYUP = 3;
export const EV_GUI_CHAR = 4;

// Mouse events, from the same EGUIEvent enum. EV_GUI_FirstMouseEvent is 5, so:
export const EV_GUI_MOUSEMOVE = 6;
export const EV_GUI_LBUTTONDOWN = 7;
export const EV_GUI_LBUTTONUP = 8;
export const EV_GUI_LBUTTONDBLCLICK = 9;
export const EV_GUI_WHEELUP = 16;
export const EV_GUI_WHEELDOWN = 17;

const GK = {
  left: 5,
  right: 6,
  backspace: 8,
  down: 10,
  up: 11,
  enter: 13,
  escape: 27,
} as const;

export type MenuKey = "up" | "down" | "left" | "right" | "enter" | "back" | "backspace";

const MENU_KEY_CODE: Record<MenuKey, number> = {
  up: GK.up,
  down: GK.down,
  left: GK.left,
  right: GK.right,
  enter: GK.enter,
  back: GK.escape,
  backspace: GK.backspace,
};

export interface InputEvent {
  evtype: number;
  subtype: number;
  data1: number;
  data2: number;
}

/** Build the GUI key-down event the menu system responds to for a named key. */
export function menuKeyEvent(key: MenuKey): InputEvent {
  return { evtype: EV_GUI_EVENT, subtype: EV_GUI_KEYDOWN, data1: MENU_KEY_CODE[key], data2: 0 };
}

/**
 * The matching key-UP.
 *
 * Sending only the key-down is a trap. M_Responder latches the key into MenuButtons[] on the way
 * down and unlatches it on the way up, and M_Ticker repeats whatever is still latched -- so a single
 * "down" delivered without its release walks the selection down the whole list and keeps going. Every
 * key this bridge sends must be released, or the caller is testing an auto-repeat rather than a
 * keypress.
 */
export function menuKeyUpEvent(key: MenuKey): InputEvent {
  return { evtype: EV_GUI_EVENT, subtype: EV_GUI_KEYUP, data1: MENU_KEY_CODE[key], data2: 0 };
}

/** Pointer motion, so hover-driven UI (tooltips, hot states) can be exercised. */
export function mouseMoveEvent(x: number, y: number): InputEvent {
  return { evtype: EV_GUI_EVENT, subtype: EV_GUI_MOUSEMOVE, data1: x, data2: y };
}

export function mouseButtonEvent(x: number, y: number, down: boolean, dblclick = false): InputEvent {
  const subtype = dblclick
    ? EV_GUI_LBUTTONDBLCLICK
    : down
      ? EV_GUI_LBUTTONDOWN
      : EV_GUI_LBUTTONUP;
  return { evtype: EV_GUI_EVENT, subtype, data1: x, data2: y };
}

export function wheelEvent(up: boolean): InputEvent {
  return { evtype: EV_GUI_EVENT, subtype: up ? EV_GUI_WHEELUP : EV_GUI_WHEELDOWN, data1: 0, data2: 0 };
}

/** Build the GUI character event a menu text field appends (one character). */
export function charEvent(ch: string): InputEvent {
  return { evtype: EV_GUI_EVENT, subtype: EV_GUI_CHAR, data1: ch.charCodeAt(0), data2: 0 };
}
