# Layout Library — design

Date: 2026-09-28. Status: approved in chat, awaiting spec review.

## Goal

A second tab in the Grandpa's Greenhouse panel where Max draws garden layouts from scratch
with every plantable species, keeps several named layouts, and activates one so the
assistant plants and maintains it exactly like a computed plan. Layouts are stored as JSON
in the game save and can be exported/imported as JSON text.

## Non-goals

- No scoring/yield display for custom layouts (no defined target). Possible later: target picker.
- No drag painting; click per tile.
- No disk file I/O from the mod (browser context); JSON export/import via copy/paste covers it.

## UI

### Tabs
- `S.tab`: `'assistant' | 'layouts'`, persisted with the other settings.
- Title row gains two tab buttons, "Assistant" and "Layouts". Assistant tab renders exactly
  the current panel content. Rendering swaps on the existing rebuild path; event wiring stays
  on the panel's `data-act` delegation.

### Editor (Layouts tab)
- 6x6 grid of `ggCell`-style cells, larger than the preview cells. Locked plot tiles inert
  and shown like the preview's `ggLocked`.
- Palette below the grid: every plantable species from `M.plants` in game order — unlocked
  ones normal, locked ones greyed with a "not unlocked yet" tooltip (still selectable, they
  just will not plant until unlocked) — plus an "empty" eraser swatch.
- Click a palette swatch to select the brush; click a grid tile to paint it. Painting writes
  through to the stored layout immediately (no separate save step).
- Legend/colour handling reuses `speciesColors`.

## Library

- `S.layouts`: array of `{name, grid}` where `grid` is the same 6x6 string-key matrix the
  planner uses (`''` = deliberately empty).
- Buttons: New (blank grid, prompted name with default), Rename, Duplicate, Delete
  (confirmation), plus per-layout Activate. Every stroke saves; there is no dirty state.
- Persistence: included in `saveString`/`loadString` with the same defensive typeof/shape
  checks the file already uses. Old saves without `layouts` load unchanged.
- Export: dialog with the JSON text of all layouts as one array, for copy.
- Import: paste JSON (array of layouts, or a single layout object), validated before
  merge — array/object shape, 6x6 grid of strings,
  species keys must exist in `M.plants` or be `''`. Invalid input is rejected with a
  message, never partially applied. Name collisions get a numeric suffix.

## Activation

- New mode `'custom'` next to `'breed'`/`'boost'`.
- Activate sets `S.mode = 'custom'` and builds `plan = {grid, key: 'custom:' + name, label: name}`.
- `rebuildPlan`, `runStep`, `removalsFor` treat `'custom'` like the other planted modes:
  planting from empty tiles, weed pulling, ask-before-clearing and `keepPlan` all work
  unchanged because they only read `plan.grid`.
- Species not yet unlocked simply do not plant (existing `plantable`/`unlocked` check);
  the tile fills once the seed is banked.
- The yield line is hidden in custom mode.

## Testing (moddev/test.js)

- Library CRUD: create, rename, duplicate, delete.
- Save/load round trip keeps layouts byte-identical.
- Import rejects malformed JSON, wrong grid shape, unknown species; accepts valid text and
  suffixes colliding names.
- Custom mode plants exactly the drawn grid and leaves `''` tiles empty.
- Locked species in an active layout are skipped by planting until unlocked.
- Tab state survives save/load.

## Versioning

`ModVersion` 1.3 -> 1.4, `main.js` `VERSION`, `Date` field — bumped in the same change
(standing rule).

## Constraints

- `main.js` ASCII only, single file, existing style (tabs, `var`, why-comments).
- Nothing reimplemented from the game; species list read from `M.plants` at runtime.
- `cd Code/moddev && node test.js` green before commit.
