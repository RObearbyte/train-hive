/**
 * Raw palette. Brand hues are kept; text-bearing shades are adjusted for WCAG AA.
 * Only files in `theme/` may contain color literals.
 */
export const brand = {
  midnightNavy: '#14263D',
  communityTeal: '#168F88',
  enduranceBlue: '#3478C0',
  emberOrange: '#F47735',
  warmSand: '#E8D8B8',
  arcticWhite: '#F5F7F8',
} as const;

export type ColorToken =
  | 'background'
  | 'surface'
  | 'surfaceRaised'
  | 'border'
  | 'borderStrong'
  | 'text'
  | 'textMuted'
  | 'primary'
  | 'onPrimary'
  | 'primarySoft'
  | 'onPrimarySoft'
  | 'accent'
  | 'onAccent'
  | 'danger'
  | 'onDanger'
  | 'success'
  | 'warning'
  | 'info'
  | 'dangerSoft'
  | 'successSoft'
  | 'warningSoft'
  | 'infoSoft'
  | 'overlay'
  | 'hero'
  | 'onHero'
  | 'onHeroMuted';

export type ColorPalette = Record<ColorToken, string>;

export const lightColors: ColorPalette = {
  background: '#F5F7F8',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  border: '#D3DBE2',
  borderStrong: '#6B7A8A',
  text: '#14263D',
  textMuted: '#4A5B6E',
  primary: '#0F766F', // darkened Community Teal so white text passes AA
  onPrimary: '#FFFFFF',
  primarySoft: '#DDF1EF',
  onPrimarySoft: '#0B5550',
  accent: '#F47735', // Ember Orange, used as a fill with navy text
  onAccent: '#14263D',
  danger: '#B3261E',
  onDanger: '#FFFFFF',
  success: '#1B6B43',
  warning: '#8A4B00',
  info: '#2A67A8', // darkened Endurance Blue for text on light surfaces
  dangerSoft: '#FBE4E2',
  successSoft: '#DDF2E5',
  warningSoft: '#F8EAD2',
  infoSoft: '#E1ECF8',
  overlay: 'rgba(20, 38, 61, 0.5)',
  hero: '#14263D', // Midnight Navy brand surface (welcome)
  onHero: '#F5F7F8', // Arctic White
  onHeroMuted: '#E8D8B8', // Warm Sand
};

export const darkColors: ColorPalette = {
  background: '#0D1A2B',
  surface: '#14263D',
  surfaceRaised: '#1C3350',
  border: '#2B4561',
  borderStrong: '#8496AA',
  text: '#F5F7F8',
  textMuted: '#AAB8C6',
  primary: '#3CC0B8',
  onPrimary: '#0D1A2B',
  primarySoft: '#17413F',
  onPrimarySoft: '#9FE6E1',
  accent: '#F47735',
  onAccent: '#14263D',
  danger: '#FF8F86',
  onDanger: '#0D1A2B',
  success: '#62D39B',
  warning: '#F2C14E',
  info: '#86B8EC',
  dangerSoft: '#4A2226',
  successSoft: '#17402B',
  warningSoft: '#4A3A14',
  infoSoft: '#1D3B5E',
  overlay: 'rgba(0, 0, 0, 0.6)',
  hero: '#14263D',
  onHero: '#F5F7F8',
  onHeroMuted: '#E8D8B8',
};
