# Quiet Lecture Desk surface brief

<!-- impeccable:surface-schema 1 -->

## Route

`/lecture-translator`

## Mode

Operate

## Direction

A quiet, premium academic workspace: ChatGPT-like history navigation, a centered bilingual reading flow, and Apple-native restraint. The product story is “open a lecture → capture English continuously → read Chinese in near real time → review structured notes.” It is a daily classroom tool, not a marketing surface.

## Interaction material

Liquid Glass is limited to the bottom control dock, active live transcript, floating/status controls, settings panel, and Ask AI panel. Ordinary transcript, notes, navigation, and history remain flat. Use subtle edge light, neutral blur, and 150–300ms motion; no scenic background, parallax, particles, decorative glow, or broad gradient.

## Responsive constraints

- Laptop-first: keep the 264px sidebar, 900px reading measure, and centered floating control dock.
- Below 760px, history becomes a drawer, transcript rows become single-column, and the dock retains only essential lecture controls.
- Support System, Light, and Dark from shared tokens and preserve `prefers-reduced-motion`.
- Preserve continuous AudioWorklet PCM streaming, Qwen/Tencent/Auto providers, partial and final transcript, IndexedDB recovery, notes, search, bookmarks, Ask AI, download, and session history.
- Settings and AI panels require dialog semantics, Escape close, focus trap/restore, and touch-safe controls.
- No DeepL and no browser SpeechRecognition fallback as the realtime core.

