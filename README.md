# Grandpa's Greenhouse

Cookie Clicker garden assistant. Reads the entire breeding table out of the game's own mutation function at startup, arranges the plot to maximise the odds for the seed you want, and asks before it uproots anything.

Cookie Clicker Farm / garden minigame. Version 1.0.

- Nothing about the breeding tree is hardcoded - it is probed out of the game's own M.getMuts, ceilings included.
- Prices rival mutations exactly: the game plants only one winner per tile, chosen at random from every roll that passed.
- Beats the community's hand-drawn layouts in 4 of 6 cases and matches them in the other 2.
- 28 of 34 species unlocked unattended in 3000 garden steps, against 6.4 for tending alone.
- Never uproots a plant that would keep living without asking first.

## Layout

```
mod/        what the game loads, and all that ships to the Workshop
moddev/     the test harness - never loaded, never shipped
```

The split matters: the game publishes a mod by zipping its folder whole
(`resources/app/start.js`), so anything sitting beside `main.js` is uploaded to
every subscriber. The harness lives outside `mod/` so that cannot happen, and
the repository's own `.git` directory is outside it for the same reason.

## Installing

`mod/` is what goes into `Cookie Clicker/resources/app/mods/local/GrandpasGreenhouse`. On
the machine this was developed on that path is a directory junction pointing
here, so the game and the repository share one copy and an edit is live
immediately.

Restart the game and enable the mod under **Options -> Mods**.

## Testing

```
cd moddev
node test.js
```

105 tests. They do not run against a model of the game - `moddev/garden.js`
loads Cookie Clicker's own minigame source into a sandbox with a seeded PRNG and
stubs for the DOM, so a passing test is testing the real thing.

| Script | What it answers |
|---|---|
| `moddev/test.js` | behavioural tests |
| `moddev/bench.js` | seeds discovered, unattended |
| `moddev/layouts.js` | layouts scored against the community charts |

The harness resolves its paths for both locations, so the tests run from the
repository and from inside the game tree.

## A note on history

This repository starts at the version above. The mod existed before it, but that
work was never under version control, so there is nothing earlier to import -
the first commit is the state as it shipped, not a reconstruction.
