---
schemaVersion: 2
name: Quiet Lecture Desk
description: A calm, premium academic workspace for long-form live translation and revision notes.
colors:
  background-light: "#f7f7f5"
  sidebar-light: "#efefec"
  surface-light: "#ffffff"
  text-light: "#1f211f"
  secondary-light: "#626660"
  accent-light: "#2d6650"
  background-dark: "#181a18"
  sidebar-dark: "#20221f"
  surface-dark: "#222521"
  text-dark: "#f1f2ee"
  secondary-dark: "#b0b4ac"
  accent-dark: "#82b89d"
typography:
  family: '-apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "PingFang SC", "Noto Sans SC", sans-serif'
  lecture-title: "22–30px / 570 / -.035em"
  source: "17px / 1.65 / 400"
  translation: "15.5px / 1.72 / 400"
  notes-title: "30–44px / 540 / -.045em"
  label: "10–12.5px / 500–650"
rounded:
  compact: "8px"
  control: "10–13px"
  active: "16px"
  dock: "19px"
  panel: "20px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "28px"
  section: "54px"
components:
  sidebar: "264px desktop history rail; drawer below 760px"
  reading-width: "900px transcript and notes"
  header-width: "1080px"
  control-dock: "26px blur, 19px radius, centered floating toolbar"
  active-segment: "18px blur, 16px radius, restrained accent edge"
  panel: "30px blur, 20px radius, modal focus management"
---

# Design System: Quiet Lecture Desk

## Overview

**Creative North Star: Quiet premium daily-use academic lecture translator.**

The product should feel like ChatGPT and a native Apple study tool were reduced to the essentials of listening, reading, and revision. It is an application used for two or three hours at a time, not a landing page. Content leads; interface chrome recedes. The dominant experience is a steady bilingual transcript followed by structured notes.

Liquid Glass is an interaction material, not the page theme. Use it on the floating control dock, active transcript, floating/status controls, and settings or AI panels. Ordinary transcript, notes, history, and navigation stay flat and quiet.

## Colors

Light mode uses warm white and graphite: `#f7f7f5` background, `#efefec` sidebar, `#ffffff` surface, `#1f211f` primary text, `#626660` secondary text, and `#2d6650` accent. Dark mode uses `#181a18`, `#20221f`, `#222521`, `#f1f2ee`, `#b0b4ac`, and `#82b89d` respectively.

Accent is reserved for connection state, active listening, focus, selected actions, and small study emphasis. Danger red is a status signal only. Do not introduce purple-blue AI gradients, large color washes, rainbow treatments, or decorative glow.

## Typography

Use the system stack from frontmatter across English and Chinese. The lecture title is 22–30px with restrained 570 weight. Source transcript is 17px with 1.65 leading; Chinese translation is slightly quieter at 15.5px with 1.72 leading. Notes may use 30–44px editorial titles, but navigation and controls remain 10–13px.

Use weight, spacing, and readable measure for hierarchy. Do not turn every label into bold display type. Preserve formulas, units, numbers, names, and English academic terminology.

## Layout

Desktop uses a 264px history sidebar, a centered 1080px header, and a 900px transcript/notes measure. The main surface is a continuous reading flow, not a card dashboard. Tabs sit on a hairline divider and the control dock floats above the lower edge.

At 760px and below, history becomes a left drawer, header controls simplify, transcript rows become single-column, and the dock hides secondary provider/language controls while retaining Start/Pause/Resume/End. Mobile prioritizes reading and reviewing; laptop remains the primary working surface.

## Elevation & Depth

Depth is limited to active interaction. The dock uses 26px blur and a soft inset highlight. The live segment uses 18px blur. Jump-to-live and transient status use 16px blur. Settings and Ask AI panels use 30px blur with restrained directional shadow. Everything else stays close to the page plane.

Pointer highlights may track within glass controls at approximately 1.01 scale. Transitions should generally last 150–300ms. Respect `prefers-reduced-motion`; never animate the page background.

## Shapes

Use compact 8–13px radii for ordinary controls, 16px for the active transcript, 19px for the dock, and 20px for floating panels. Borders are neutral hairlines. Transcript sentences are separated by rhythm and dividers, never individual cards. Touch targets stay comfortably operable on mobile.

## Components

- **Sidebar/history:** quiet navigation with grouped Today, Previous 7 Days, and Previous 30 Days sessions.
- **Lecture header:** editable course/title plus weak date, duration, provider, and connection metadata.
- **Transcript segment:** open English/Chinese reading block with hover-only actions; use `content-visibility` for long sessions.
- **Live segment:** the only glass reading surface, with partial source, translation, and a restrained cursor.
- **Control dock:** the signature glass toolbar with real microphone level, state controls, provider, language, and connection state.
- **Notes:** editorial sections, sparse concept grids, formulas, transcript-grounded visualizations, and clickable timeline.
- **Settings / Ask AI:** accessible modal side panels with Escape close, trapped/restored focus, and server-only API status.

## Do's and Don'ts

### Do

- Keep content, real-time state, and long-session readability primary.
- Keep Liquid Glass tied to interaction and active state.
- Support Light, Dark, and System from one token system.
- Preserve Auto, Qwen, and Tencent provider choices; Auto manages Qwen-to-Tencent fallback.
- Keep mobile transcript and notes readable without copying the full desktop control density.

### Don't

- Do not restore Alpine imagery, full-screen scenic backgrounds, parallax, or background customization as the product theme.
- Do not add a hero, marketing copy, dashboard card grid, oversized gradients, particles, or HUD styling.
- Do not expose provider secrets or full API keys in the browser.
- Do not add DeepL or replace continuous PCM/WebSocket streaming with browser speech recognition.
- Do not apply blur to ordinary transcript history or every content container.

