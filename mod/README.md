# Grandpa's Greenhouse

A helper for Cookie Clicker's Farm minigame. Pick a seed you are missing and it
works out which parents breed it, arranges the plot to maximise the odds, keeps
that layout planted, and harvests a new species the moment it matures so the
seed is banked.

Install: the folder sits in `mods/local/GrandpasGreenhouse`. Restart the game and
enable it under **Options -> Mods**. The panel appears under the garden.

---

## It reads the tree out of the game

The garden's whole breeding tree is already in the game, in one pure function:

```js
M.getMuts(neighs, neighsM)   // neighbourhood in, list of [species, chance] out
```

Nothing about it is typed out here. At startup the assistant feeds that function
synthetic neighbourhoods - every species alone at counts 1-8, then every pair
that fits in eight tiles - and reads the entire table back out. No rule in
`getMuts` names more than two species, so singles and pairs recover all of it,
in about 15,000 probes and a few tens of milliseconds.

The ceilings come out the same way. Some recipes stop firing once a parent gets
too common (`clover` needs two mature clover *and* fewer than five in total), so
each recipe is re-probed at rising counts until it disappears. That is what
stops a layout from simply being "as many as will fit".

If Orteil retunes a recipe, this follows without an edit.

The same trick prices a layout: to score a plan, ask the game what each empty
tile in it would offer. To score a boost garden, plant the candidate on a
scratch plot and read `M.effs`. Nothing here models the game; it asks it.

## Rival mutations are priced in

The game rolls every mutation a neighbourhood offers, collects the ones that
passed, and then plants exactly **one** of them, chosen uniformly. So a target's
real chance of landing is not the number in the table.

Two mature Baker's wheat offer:

```
bakerWheat  20%      thumbcorn  5%      bakeberry  0.1%
```

Chasing bakeberry, the 0.1% is only what gets it into the draw. About a quarter
of the time wheat or thumbcorn is in there with it and takes the tile instead.
The assistant computes the exact expectation - the rival successes are a small
Poisson-binomial, so convolving the distribution is cheaper than sampling it -
and scores layouts on what actually lands.

## A parent only counts while it is mature

`getMuts` reads two maps: `neighs`, every neighbour whatever its age, and
`neighsM`, only those past their own `mature` age. Nearly every recipe keys off
the second. Scoring a layout as if it were fully grown therefore prices a state
the garden is rarely in, and prices it wrong by a different factor for each rule.

How much of a replant cycle a plant spends mature is not a detail
(`node moddev/odds.js` prints all 34):

```
plant              mature at  steps to grow   grown for
Thumbcorn                 20              3       73.3%
Chocoroot                 25              6       68.0%
Baker's wheat             35              4       53.8%
Bakeberry                 50             33       47.8%
Cronerice                 55             73       43.2%
Shimmerlily               70              9       23.1%
Queenbeet                 80             67       18.1%
Duketater                 95            211        3.6%
Elderwort                 90            164      100.0%   immortal
```

And the two parents of a recipe rarely grow at the same speed. Elderwort is bred
from a mature shimmerlily beside a mature cronerice: shimmerlily is grown nine
steps after planting and dead a few steps later, while cronerice needs
seventy-three steps just to come of age. Both windows have to be open at once,
which happens on about a tenth of the steps a snapshot counts.

So a tile is not scored once. For each species around it the number of copies
currently grown is binomial - independent draws, the honest assumption for
neighbours on different clocks that are replanted as tiles free up - and every
state is enumerated and priced by the game's own `getMuts`. A parent a rule
merely counts (`neighs`, like the three duketaters behind Shriekbulb) costs
nothing at all. A parent it needs grown costs its odds. Two of them cost both.

The layout search then does the allocation by itself: when one parent is the
bottleneck, another copy of *it* raises the chance of an overlap far more than
another copy of the quick one, which a fully-grown snapshot cannot see, because
in a snapshot three is three.

### The margin before a plant withers is measured in steps

A plant dies at 100, so one worth keeping is taken shortly before that. Measured
in age, that margin means something different for every species: twelve age is a
step and a half of baker's wheat but twenty steps of elderwort - and duketater is
not mature until 95, so a fixed margin took the late bloomers on the first step
they could breed. The margin is now one of the plant's own growth steps, so
everything keeps the window it was planted for. It is worth half a species on the
discovery benchmark in Tend mode alone.

## Choosing what to work on

The obvious rule is "chase the missing seed with the best odds". It gets stuck,
badly. Measured over 3,000 garden steps from a fresh save, it plateaus around
**4 of 34**: it finds whatever is cheapest to roll and grinds on it, while the
branches that would open a dozen more seeds sit untouched.

So each candidate is scored by `chance x seeds it unblocks`. A 1% seed that
opens four others beats a 5% dead end.

### Farming the weed has to compete

Half the tree - the whole fungus branch - sits behind meddleweed, and the game
only sprouts a weed in a tile that has **no neighbours at all**. A tidy, fully
planted garden therefore locks that half of the collection away permanently.

Making the nursery a fallback ("only when nothing else is growable") does not
work either, because there is almost always *something* sowable: from a plot of
elderwort the game offers Shriekbulb at 0.1% forever. One benchmark seed sat at
9 of 34 doing exactly that.

So an empty plot competes as an option in its own right, scored in the same
units. When it wins, the assistant deliberately clears the plot, waits for
meddleweed, and lets it ripen to age 90 before uprooting it - the spore it drops
when pulled is worth `0.2 * age/100`, so about 18% at 90 against 10% at
maturity.

## Benchmark

`moddev/garden.js` loads the game's real `minigameGarden.js` into a sandbox with a
seeded PRNG, so this is the game's own growth, spreading and mutation code. The
only thing being measured is the assistant's choices.

Starting from a fresh save that knows only Baker's wheat, farm level 9:

```
node moddev/bench.js 3000 20

3000 garden steps, 20 seeds

                seeds unlocked of 34
  Tend mode                     6.8
  Breed mode                   28.6    (per seed: 30, 28, 28, 27, 31, 32, 29,
                                        29, 28, 32, 14, 28, 32, 29, 29, 31,
                                        28, 28, 30, 30)

  Breed, steps to reach N species (every seed)
   5 by step 189     10 by step 689
```

The 14 is real and is not the layout planner: on that seed eleven immortal
elderwort end up scattered across the plot, the nursery needs bare tiles with no
neighbours at all, and neither condition can give - so it waits for a weed that
can never sprout. One seed in twenty, and a known hole.

Tend is not a strawman - it harvests everything mature, which is what banks a
seed. It still finds only six, because the tree needs specific parents adjacent
in specific counts, and left to itself the plot never arranges them.

It plateaus around 29 of 34. The last few - Everdaisy (three mature tidygrass
*and* three mature elderwort at once, 0.2%), Queenbeet lump (eight mature
queenbeets around one tile, 0.1%), Shriekbulb, Ichorpuff - are rare enough to
want a dedicated plot and patience. It keeps working on them; do not expect all
34 overnight.

### What the two fixes above were worth

Both were found by this benchmark, and both were real bugs rather than tuning.
The figures below are historical - they were measured before the harness ran on
a virtual clock (see below), so they are comparable with each other but not with
the table above:

```
                                                 seeds of 34
  best-odds targeting, unbanked mutations cleared        2.7
  + expected-progress targeting                          4.0
  + let unbanked mutations ripen                        22.0
  + nursery competes as an option                       28.8
```

The middle one is the interesting one. Clearing "what the layout did not ask
for" quietly destroyed every new species the moment it appeared: a mutation is
by definition not yet banked, and `M.harvest` only unlocks a seed at
`age >= mature`, so uprooting it early banked nothing. The assistant was
demolishing exactly what it existed to produce, which is why it scored *worse*
than doing almost nothing.

## The layouts, checked against the community charts

Hill climbing is a local search, and local search is only as good as where it
starts. Two recipes proved that the hard way, both found by scoring the
assistant's layout against the hand-drawn shapes from the community garden
charts through the mod's own scorer, so both sides are judged on one rule and the
comparison is in expected mutations per step rather than in how similar the
pictures look (`node moddev/layouts.js`):

- **Juicy queenbeet** wants eight mature queenbeets around one empty tile. Until
  all eight are down the score is flat zero, so no single-tile change looks like
  an improvement and the climb never left the empty plot. It scored **0.0000**
  against the chart's 0.0040 - the seed was simply unreachable.
- **Shriekbulb** off five elderwort wants a ring: a border and a filled core with
  a moat between them, so moat tiles see plants from both sides. The climb does
  not stumble onto a ring, and lost to the chart by 8%.

Both are fixed by starting the climb from better shapes - a solid block with
isolated single-tile holes, and a ring - rather than by changing the search.

```
node moddev/layouts.js

                                    best hand-drawn    the assistant
Bakeberry      (2x baker's wheat)            0.0116          0.0116   +0.7%
Queenbeet      (chocoroot + bakeberry)       0.0852          0.1175    +38%
Juicy queenbeet(8x queenbeet)              4.55e-9         4.55e-9    same
Golden clover  (4x clover)                   0.0046          0.0049     +7%
Shriekbulb     (5x elderwort)                0.0120          0.0120    same
Everdaisy      (3x tidygrass + 3x elderwort) 0.0035          0.0069    +96%
```

Where it wins it is usually for the same reason: the charts draw a tidy
checkerboard, and a checkerboard wastes adjacency. Clustering the parents into
pairs puts more empty tiles next to the two mature plants a recipe actually
needs.

Pricing maturity moves this table twice over. Every number falls, because a
snapshot was counting parents that are not there yet - Juicy queenbeet wants
eight grown queenbeets at once and each is grown 18% of the time, so a layout
that looks like 0.004 a step is really one seed every two hundred million steps.
And it changes which hand-drawn shape is the best of them: for Golden clover
the chart's alternating rows lose to alternating columns, and for Everdaisy the
paired rows lose to a solid block with holes.

## Modes

| Mode | What it does |
|---|---|
| **Off** | Nothing is touched. The panel still shows recipes and progress. |
| **Tend** | Harvests anything new, clears plants about to expire, uproots ripe meddleweed. Your layout is left alone. |
| **Breed** | Works towards one seed - yours from the seed picker, or its own pick. Lays out the plot and keeps it planted. |
| **Boost** | Fills the plot with the layout that maximises a bonus you choose. |

### Boost is optimised against the real effect calculation

Each candidate layout is scored by running the game's own `computeEffs` on it,
so plot-boost interactions and the multiplicative penalties are exact rather
than estimated.

The candidate shortlist is built in two passes: species that move the number on
their own, plus species that move it *when they surround something else*. That
second pass is what finds Nursetulip, which does nothing by itself except cost
2% CpS but lifts all eight neighbours by 20%.

Every probe runs on a scratch plot. The real plot and both effect caches are
restored on the way out, and `moddev/test.js` asserts they come back
byte-identical.

## It asks before it takes anything

Uprooting is the only thing here you can lose work to, so it is the only thing
that waits for an answer. Switch to Breed or Boost with a garden already
growing and the panel says so instead of acting:

```
! 4 plants stand in the way of this layout (4x Ordinary clover). Uproot them?
  [ Clear them ]  [ Keep them ]
```

Everything else - planting into free tiles, harvesting a new species so the seed
is banked, taking a mature plant before it rots - runs straight through. The
question is only ever about plants that would otherwise keep living.

Three things about it are deliberate:

- **The answer is scoped to the layout it was given for.** Change mode, target
  or plot size and it asks again, because the plan it was answering no longer
  exists. It is not saved either, so reloading asks again.
- **"Keep them" is a real answer, not a delay.** Those plants stay, and the
  layout simply fills in around them as tiles free up on their own.
- **Nothing that was never at risk appears in the question**: weeds, immortals,
  species you have not banked yet, and anything already inside the expiry margin
  - that last one was going to die this cycle anyway, so taking it is strictly
  better than letting it rot, and not worth a prompt.

The list the panel asks about is produced by the same function that does the
uprooting, so the question and the action cannot drift apart.

## Settings

Five checkboxes, under **Settings**.

| Setting | Default | What it does |
|---|---|---|
| Harvest new species on sight | on | Banks a seed the moment it matures. This is what unlocks things. |
| Harvest mature plants before they expire | on | Clears a tile before the plant rots. |
| Keep the layout planted | on | Replants the plan as tiles free up. |
| Uproot ripe meddleweed the layout does not want | on | Weeds the plan needs are kept, and none are pulled before they ripen. |
| Ask before uprooting plants that stand in the way of the layout | on | The confirmation above. Turn it off and the assistant clears straight through, the way it used to. |

The rest - the expiry margin, the ripening age, the per-step spending cap - live
in `DEFAULTS` in `main.js`. They are still real settings and can be injected
through the mod's `load()` hook.

## Reading the panel

- **Seeds x/34** and how much of the plot is in use.
- In Breed, a **seed picker**: one tile per species you are still missing,
  drawn with the game's own seed-packet icons from `gardenPlants.png`. Click one
  to work towards it; hover for its best route and odds. The tiles are ordered
  the way the assistant ranks them, so the leftmost is what it would pick on its
  own, and seeds whose parents you cannot sow yet stay in the grid greyed out
  rather than disappearing - knowing a seed is out of reach is half the picture.
  The **Auto** tile hands the choice back to the assistant.
- The chosen seed's chance, and the recipe underneath:
  *needs 1x mature Chocoroot + 1x mature Bakeberry next to an empty tile*.
- Boost's six objectives are phrases with no icon to show, so that one stays a
  dropdown.
- **Layout** is a small map of the plot: one colour per species, dashed squares
  are deliberately left empty for mutations to land in, blank squares are tiles
  your farm level has not unlocked. Hover any square for the plant.
- The status lines give the expected yield - per step, or as "one about every N
  steps" once a recipe is slower than that - when the next garden step
  lands, what the assistant did last step, and a running count.

## How it is built

- **Startup.** Polls for the minigame every logic frame, so it starts whenever
  the Farm becomes available rather than on a one-shot timer.
- **Tick driver.** Uses the documented `logic` hook and watches `M.nextStep`. No
  monkey-patching of any game internal.
- **Sound and sparkles.** Planting writes the tile and calls `Game.Spend`
  directly instead of going through `M.useTool`, which would fire a sparkle at
  the mouse and a sound effect twenty times a step.
- **Immortal plants are never uprooted** for a layout. Elderwort and Everdaisy
  cost real time to grow.
- **Spending cap.** At most 15% of your cookies per garden step, so the
  assistant cannot empty the bank you need for buildings.
- **Fails visibly.** The tick body is wrapped; an error shows in the panel and
  the console instead of taking `Game.Logic()` down with it.
- **ASCII-only source.** The game's `index.html` declares no `<meta charset>`
  and injects mod scripts with `createElement('script')`, so a stray multibyte
  character can be misdecoded at load time.
- `Game.mods['grandpas greenhouse']` exposes a small read-only API -
  `getRecipes`, `getRecipe`, `getPlan`, `getStats`, `getMatureOdds`,
  `getLandChance`, `getSnapshotChance`, `setMode`, `setTarget`, `setObjective`,
  `replan` - which is what the test harness drives.

## Reproducing any of it

The tooling lives in the sibling folder `mods/local/GrandpasGreenhouseDev`, not in
the mod, because the game zips the whole mod folder when publishing.

```
node moddev/test.js          # 127 behavioural tests against the real garden
node moddev/bench.js 3000 20 # the discovery benchmark above
node moddev/layouts.js       # layouts against the community charts
node moddev/odds.js          # how much of its life each plant spends mature
```

The sandbox runs on a **virtual clock**. A garden step is minutes apart in a real
game and microseconds apart here, and the mod tells one step from the next by
watching `M.nextStep`, which is `Date.now()` plus the step length - so on the
real clock two steps inside the same millisecond looked like one, the mod sat out
its turn, and how often that happened depended on how fast the machine was and on
how long its own planner took. The harness now winds the clock by hand, one
step's worth per step, and the same seed grows the same garden twice. Every
number here was measured after that fix; anything measured before it was noise
worth up to three species.

## Notes

- The assistant only acts on a garden step - every 5 minutes on dirt. Nothing
  happens in between.
- Wood chips triple spreading and mutation, which is what you want while
  breeding. Clay adds 25% to passive effects, which is what you want for a boost
  garden. The assistant does not change your soil for you.
- Sell your garden before ascending if you care about the plants: the plot
  resets and unsold stock is simply gone.
- `info.txt` sets `AllowSteamAchievs: 1`, so achievements keep unlocking. Set it
  to `0` if you would rather block them.
- The recipe table is read from game v2.053. It is re-read at every startup, so
  a patched game gives a patched table without touching this mod.
