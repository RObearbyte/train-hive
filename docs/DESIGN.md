# TrainHive design system

Bear-inspired sports-tech: premium but approachable, athletic but not aggressive. Subtle hexagon geometry, calm motion (only `Pressable` feedback), light and dark themes. Everything lives in `src/ui/` and is imported from `@/ui`. Colors exist only in `src/ui/theme/`; components read them through `useTheme()` (system color scheme).

## Tokens

Brand: Midnight Navy `#14263D`, Community Teal `#168F88`, Endurance Blue `#3478C0`, Ember Orange `#F47735`, Warm Sand `#E8D8B8`, Arctic White `#F5F7F8`. Raw brand shades that failed AA as text were darkened or lightened (same hue) rather than used as-is.

| Token | Light | Dark | Use |
|---|---|---|---|
| background | #F5F7F8 | #0D1A2B | screen |
| surface / surfaceRaised | #FFFFFF / #FFFFFF | #14263D / #1C3350 | cards, inputs, list rows |
| border / borderStrong | #D3DBE2 / #6B7A8A | #2B4561 / #8496AA | dividers / input and control outlines (3:1) |
| text / textMuted | #14263D / #4A5B6E | #F5F7F8 / #AAB8C6 | body / secondary |
| primary / onPrimary | #0F766F / #FFFFFF | #3CC0B8 / #0D1A2B | main action (teal; light shade darkened so white text passes) |
| primarySoft / onPrimarySoft | #DDF1EF / #0B5550 | #17413F / #9FE6E1 | selected/pressed tint |
| accent / onAccent | #F47735 / #14263D | #F47735 / #14263D | Ember Orange **fill only**, with navy text (white on orange is 2.6:1, fails) |
| danger / onDanger | #B3261E / #FFFFFF | #FF8F86 / #0D1A2B | destructive, errors |
| success, warning, info | #1B6B43, #8A4B00, #2A67A8 | #62D39B, #F2C14E, #86B8EC | semantic text/icons |
| hero / onHero / onHeroMuted | #14263D / #F5F7F8 / #E8D8B8 | #14263D / #F5F7F8 / #E8D8B8 | brand hero surface (welcome screen): Midnight Navy with Arctic White text and Warm Sand secondary text. Same in both themes; use with `HexMotif`. onHero 14.22:1, onHeroMuted 10.87:1 on hero |
| dangerSoft, successSoft, warningSoft, infoSoft | tinted backgrounds for Banner and status | | |

Other scales: spacing `xxs 2, xs 4, sm 8, md 12, lg 16, xl 24, xxl 32, xxxl 48`; radii `sm 6, md 10, lg 16, xl 24, pill`; `MIN_TOUCH_TARGET = 44`; elevation `none/low/medium`.
Typography (system font): display 34/40 800, title 24/30 700, heading 18/24 700, body 16/22 400, label 15/20 600, caption 13/18 400. Text allows font scaling up to 1.6x.

## Contrast (WCAG 2.x, computed from the token values)

Required: 4.5:1 for text, 3:1 for large text and UI boundaries. Every pair used by the components passes; the lowest text ratio is 4.87 (info on infoSoft, light) and the lowest UI-boundary ratio is 4.09.

| Pair | Light | Dark |
|---|---|---|
| text on background / surface | 14.22 / 15.28 | 16.29 / 14.22 |
| textMuted on background / surface | 6.49 / 6.97 | 8.65 / 7.55 |
| onPrimary on primary | 5.47 | 7.86 |
| onPrimarySoft on primarySoft | 7.37 | 7.98 |
| onAccent on accent | 5.48 | 5.48 |
| onDanger on danger | 6.54 | 7.94 |
| primary on surface (secondary button, ghost) | 5.47 | 6.86 |
| danger / success / warning / info on surface | 6.54 / 6.50 / 6.80 / 5.83 | 6.93 / 8.23 / 9.10 / 7.34 |
| text on dangerSoft / successSoft / warningSoft / infoSoft | 12.59 / 13.03 / 12.87 / 12.77 | 12.62 / 10.83 / 10.25 / 10.62 |
| accent-tone icon on its Soft bg: danger / success / warning / info | 5.38 / 5.54 / 5.73 / 4.87 | 6.15 / 6.27 / 6.56 / 5.48 |
| borderStrong on surface / background (UI, 3:1) | 4.40 / 4.09 | 5.04 / 5.77 |
| Status fg on its bg: see below | all >= 5.38 | all >= 6.15 |

Decorative `border` (dividers, card outlines) is intentionally low contrast; controls use `borderStrong`. The Ember Orange accent is never used as text or a lone indicator on light backgrounds (2.59:1 on Arctic White).

## Training status mapping

Status is always glyph + label + fill style, never color alone. Provisional states are **outlined**, settled states are **filled/tinted**. `TrainingDisplayStatus` is exported from `@/ui`; `statusMeta` and `useTheme().status` hold the mapping.

| Status | Label | Glyph | Style | Light fg on bg | Dark fg on bg |
|---|---|---|---|---|---|
| awaiting_minimum | Awaiting minimum | circle | outlined, blue | 5.83 (info on surface) | 7.34 |
| minimum_reached | Minimum reached | half-filled circle | **dashed** outline, teal (provisional) | 5.47 | 6.86 |
| finalizing | Finalizing | clock | tinted, warning | 5.73 | 6.56 |
| confirmed | Confirmed | check | **filled** teal | 5.47 | 7.86 |
| cancelled_insufficient | Cancelled: too few | cross | tinted, danger | 5.38 | 6.15 |
| cancelled_organizer | Cancelled by organizer | ban | filled danger | 6.54 | 7.94 |
| completed | Completed | flag | filled neutral | 6.97 | 7.55 |

`StatusBadge` accepts an optional `label` override (e.g. "3 more needed" with `awaiting_minimum`); the glyph and style stay.

## Components (`src/ui/components`)

| Component | Notes |
|---|---|
| Screen | `SafeAreaView` + background; `scroll`, `padded`, `onRefresh`/`refreshing`, `edges` (reduce when a navigator header/tab bar already covers an edge). |
| Text | `variant` display/title/heading/body/label/caption, `color` = any color token. Headings get `accessibilityRole="header"`. |
| Button | primary/secondary/ghost/danger, sm(44)/md(50)/lg(56), `loading` (spinner, busy+disabled state), `disabled`, `icon`, `fullWidth`. Always has a text label. |
| IconButton | 44x44, `accessibilityLabel` is required. |
| Card | Raised surface; `onPress` makes it a button (give it an `accessibilityLabel` summarising the content). |
| TextField | Label above, helper, error (icon + text, live region), `ref` as a prop (React 19), spreads `TextInput` props so `<Controller render={({field}) => <TextField ref={field.ref} value={field.value} onChangeText={field.onChange} onBlur={field.onBlur} error={errors.x?.message} />}>` works. |
| StatusBadge | See mapping above. |
| ProgressBar | `value`, `target`, `minimum`. A dark tick marks the minimum; the bar is blue below it and teal once reached. Reads as "7 of 10 confirmed. Minimum 6, reached". |
| SegmentedControl | Generic over a string union; tab semantics; 44pt segments. |
| RsvpToggle | Two 60pt options "I'm going" / "Not going"; going = filled teal, not going = filled grey, both with check glyphs; tapping the selected one emits `no_response`; `pending` shows a spinner on the tapped option and ignores taps. |
| ListItem | Title/subtitle, `leading`/`trailing` nodes, chevron when pressable. |
| Avatar | Initials on a soft tint chosen from the name. |
| Banner | info/success/warning/error with distinct glyph and spoken prefix; optional action. |
| EmptyState, LoadingState, ErrorState | Centered blocks; ErrorState has a retry button; the error is announced as an alert. |
| Divider | Hairline, hidden from accessibility. |
| HexMotif | Decorative hexagon lattice that fades towards the left, absolutely fills its parent; place in a header or welcome background. Hidden from accessibility. Needs `react-native-svg`. |
| Icon | Small SVG glyph set (`IconName`, 24 viewBox, 2px round stroke), decorative; the parent supplies the label. Names: circle, circle-half, clock, check, check-circle, close, ban, flag, info, alert, plus, chevron-left, chevron-right, refresh, home, calendar, person, people, map-pin, edit, share, copy, bell, megaphone, chart, external-link, trash. |

## Screen guidance

**Welcome / onboarding.** Navy header area with `HexMotif`, the "One Pack. Stronger together." line, then one task per screen. Code entry: a single `TextField` ("Invitation code", helper "Ask your organizer"), uppercase, no autocorrect, a full-width primary `Button` below; invalid or expired code shows the field error and nothing else changes. Name entry: one `TextField` ("What should your pack call you?"), helper "Shown to your community", primary button "Join". Keep the keyboard visible and the button above it (`Screen scroll`).

**Training card** (list and Home). Order answers the five questions: 1) When: weekday + date + time, `heading`, first line. 2) Where: location, `body`, with the sport/title above it as `label`. 3) How many: `ProgressBar` with the minimum marker and "7 / 10 confirmed". 4) Will it happen: `StatusBadge` (use the "N more needed" label override for awaiting). 5) Am I going: a compact line "You're going" / "Not going" / "No answer yet" with the matching glyph; the full `RsvpToggle` lives on Home and details, not on list cards. Whole card is one pressable with a summarising `accessibilityLabel`.

**Training details.** Same hierarchy at larger size: title, `StatusBadge`, when/where block, then a `Banner` explaining the status in a sentence (provisional: "Minimum reached. Final confirmation happens at the deadline."; cancelled: reason), `ProgressBar`, the `RsvpToggle` (disabled with an explanation when cancelled/completed or past the deadline), then the participant list as `ListItem` + `Avatar` rows grouped Going / Not going / No response. Organizer actions (edit, cancel) are `secondary`/`danger` buttons at the bottom; cancel needs a confirmation.

**Create / edit training.** One scrolling form with `TextField`s via `Controller`: title, location, date/time, minimum, maximum (optional), RSVP deadline, notes. Inline errors on blur and on submit, a summary `Banner` for server errors, primary "Create training" button pinned to the bottom with `loading` while saving. Show the deadline rule in helper text; times are displayed in the training's time zone.

**Home tab.** Pull-to-refresh `Screen`. Top: the next training as a large Training card followed directly by the `RsvpToggle` (one-tap answer without opening details). Below: "Needs your answer" cards, then upcoming ones as compact cards. Empty: `EmptyState` ("No trainings yet", organizers get a "Create a training" action). Loading: `LoadingState`; failure: `ErrorState` with retry.

## Brand assets

`assets/brand/trainhive-mark.svg` is the source vector for the mark (hexagon holding a pack of three hexagons). The PNG app icons and splash in `assets/images/` are still the Expo placeholders; exporting PNGs from the SVG is left to a design tool.

## Not yet verified

No component has been rendered on a device or simulator. Type-check and lint pass; screen-reader behavior, dashed borders on Android, and `HexMotif` rendering need a manual check in Expo Go.
