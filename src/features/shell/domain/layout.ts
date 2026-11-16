/**
 * Responsive layout rules for the web build (and any wide window). Pure: the
 * width is passed in, nothing here reads the window.
 *
 * - Narrow (< 900): the phone layout, bottom tabs, full-width screens.
 * - Wide (>= 900): a left sidebar replaces the bottom tabs and the screen
 *   content sits in a centred column.
 */

export const WIDE_BREAKPOINT = 900;
/** Sidebar width on wide layouts. */
export const SIDEBAR_WIDTH = 232;
/** Content column for ordinary screens. */
export const CONTENT_MAX_WIDTH = 960;
/** Content column for the attendance sheet and statistics (tables and charts). */
export const WIDE_CONTENT_MAX_WIDTH = 1100;
/** Onboarding (welcome, code, name) stays a narrow, phone-like column. */
export const ONBOARDING_MAX_WIDTH = 560;
/** Dialogs and sheets become centred cards from this width. */
export const DIALOG_BREAKPOINT = 600;
/** Confirm dialogs, the community switcher and the time zone picker. */
export const DIALOG_MAX_WIDTH = 480;
/** Larger panels (attendee search, audit history). */
export const PANEL_MAX_WIDTH = 640;

export type Layout = {
  mode: 'narrow' | 'wide';
  /** Show the left sidebar instead of the bottom tab bar. */
  sidebar: boolean;
  sidebarWidth: number;
  /** Max width of the content column, or null for full width. */
  contentMaxWidth: number | null;
  onboardingMaxWidth: number | null;
};

/** `wideContent`: the current screen is a table or chart screen that may use the wider column. */
export function layoutFor(width: number, wideContent = false): Layout {
  const wide = Number.isFinite(width) && width >= WIDE_BREAKPOINT;
  return wide
    ? {
        mode: 'wide',
        sidebar: true,
        sidebarWidth: SIDEBAR_WIDTH,
        contentMaxWidth: wideContent ? WIDE_CONTENT_MAX_WIDTH : CONTENT_MAX_WIDTH,
        onboardingMaxWidth: ONBOARDING_MAX_WIDTH,
      }
    : { mode: 'narrow', sidebar: false, sidebarWidth: 0, contentMaxWidth: null, onboardingMaxWidth: null };
}

export type DialogLayout = {
  /** A centred card instead of a full-width bottom sheet or full-screen page. */
  centered: boolean;
  maxWidth: number | null;
};

export function dialogLayoutFor(width: number, kind: 'dialog' | 'panel' = 'dialog'): DialogLayout {
  const centered = Number.isFinite(width) && width >= DIALOG_BREAKPOINT;
  return {
    centered,
    maxWidth: centered ? (kind === 'panel' ? PANEL_MAX_WIDTH : DIALOG_MAX_WIDTH) : null,
  };
}

/** Screens that may use the wider column: the attendance sheet and the statistics screens. */
export function usesWideContent(pathname: string): boolean {
  return /^\/statistics(\/|$)/.test(pathname) || /^\/trainings\/[^/]+\/attendance\/?$/.test(pathname);
}
