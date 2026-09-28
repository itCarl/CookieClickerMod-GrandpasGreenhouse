/**
 * Grandpa's Greenhouse - a garden helper for Cookie Clicker's Farm.
 *
 * The garden's whole breeding tree already lives in the game, in one pure
 * function: M.getMuts(neighs, neighsM) takes a neighbourhood and returns the
 * mutations it offers. So none of it is typed out here. At startup the
 * assistant feeds that function synthetic neighbourhoods and reads the entire
 * recipe table back out, ceilings included. If Orteil retunes a recipe, this
 * follows without an edit.
 *
 * The same trick prices a layout: to score a plan, ask the game what each
 * empty tile would offer. And to score a boost garden, plant the candidate on
 * a scratch plot and read M.effs. Nothing here models the game; it asks it.
 *
 * See README.md for the mechanics this relies on.
 */
(function () {
'use strict';

var MOD_ID   = 'grandpas greenhouse';
var VERSION  = '1.2';
var PANEL_ID = 'grandpasGreenhousePanel';

/* ------------------------------------------------------------------ *
 * Modes and objectives
 * ------------------------------------------------------------------ */

var MODES = [
	{key:'off',   label:'Off',
		hint:'Nothing is touched. The panel still shows recipes and progress.'},
	{key:'tend',  label:'Tend',
		hint:'Harvests anything new so the seed is banked, clears plants about to expire, ' +
			 'uproots ripe meddleweed. Your layout is left alone.'},
	{key:'breed', label:'Breed',
		hint:'Works towards one seed. Lays out the plot for the best recipe and keeps it planted.'},
	{key:'boost', label:'Boost',
		hint:'Fills the plot with the layout that maximises the bonus you pick.'}
];

// M.effs keys, from computeEffs(). buildingCost is a cost, so lower is better.
var OBJECTIVES = [
	{key:'cps',        eff:'cps',              label:'Cookies per second'},
	{key:'click',      eff:'click',            label:'Click power'},
	{key:'golden',     eff:'goldenCookieFreq', label:'Golden cookie frequency'},
	{key:'drops',      eff:'itemDrops',        label:'Item and lump drops'},
	{key:'grandma',    eff:'grandmaCps',       label:'Grandma CpS'},
	{key:'buildings',  eff:'buildingCost',     label:'Cheaper buildings', rev:true}
];

function objectiveByKey(key) {
	for (var i = 0; i < OBJECTIVES.length; i++) if (OBJECTIVES[i].key === key) return OBJECTIVES[i];
	return OBJECTIVES[0];
}

function modeByKey(key) {
	for (var i = 0; i < MODES.length; i++) if (MODES[i].key === key) return MODES[i];
	return MODES[0];
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

var DEFAULTS = {
	mode:          'tend',
	target:        '',      // breed target; '' means "pick the easiest missing one"
	objective:     'cps',
	bankNew:       true,    // harvest a species you have not banked, the moment it matures
	harvestMature: true,    // harvest a mature plant before it dies of old age
	keepPlan:      true,    // replant the layout as tiles free up
	pullWeeds:     true,    // uproot meddleweed the plan does not want
	askBeforeClearing: true,// ask before uprooting a plant the layout does not want
	expirySteps:   1,       // steps of the plant's own growth to leave before it withers
	ripenWeeds:    90,      // let meddleweed reach this age before uprooting it
	maxSpendPct:   0.15     // most of your cookies the assistant may spend in one step
};

var SETTINGS_META = [
	{key:'bankNew',       label:'Harvest new species on sight (this is what banks a seed)',
		help:'setBank'},
	{key:'harvestMature', label:'Harvest mature plants before they expire', help:'setMature'},
	{key:'keepPlan',      label:'Keep the layout planted', help:'setPlan'},
	{key:'pullWeeds',     label:'Uproot ripe meddleweed the layout does not want', help:'setWeeds'},
	{key:'askBeforeClearing', label:'Ask before uprooting plants that stand in the way of the layout',
		help:'setAsk'}
];

var S = {};
(function () { for (var k in DEFAULTS) S[k] = DEFAULTS[k]; })();

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

var recipes    = null;  // targetKey -> [{target, chance, parents:[{key,n}], ceilings:{}}]
var recipesFor = null;  // built once, from the game's own getMuts
var plan       = null;  // {grid:[[key|'']], score, label, key}
var lastStep   = -1;
var lastPanelRefresh = 0;   // when the per-frame panel refresh last ran
var statusText = 'waiting for the garden';
var STUCK_MSG  = 'stuck - immortal plants block the weed nursery and nothing you can sow leads anywhere new';
var stats      = {harvested:0, planted:0, banked:0, uprooted:0};
var showSettings = false;
var seedGridKey = '';   // what the seed picker was last drawn for
// planKey -> 'clear' | 'keep'. Deliberately keyed by plan and deliberately not
// saved: a decision covers the layout you were shown and nothing else, so
// changing mode, target or plot size asks again, and so does reloading.
var clearDecision = {};
var keptCount = 0;
var panelJustBuilt = false;
var uiBroken   = false;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function garden() {
	if (typeof Game === 'undefined' || !Game.Objects) return null;
	var farm = Game.Objects['Farm'];
	if (!farm || !farm.minigameLoaded || !farm.minigame) return null;
	var m = farm.minigame;
	return (m.plot && m.getMuts && m.plantsById) ? m : null;
}

function plantOf(m, tile) { return (tile && tile[0] > 0) ? m.plantsById[tile[0] - 1] : null; }

function unlockedTiles(m) {
	var out = [];
	for (var y = 0; y < 6; y++) {
		for (var x = 0; x < 6; x++) if (m.isTileUnlocked(x, y)) out.push([x, y]);
	}
	return out;
}

function emptyGrid() {
	var g = [];
	for (var y = 0; y < 6; y++) { g[y] = []; for (var x = 0; x < 6; x++) g[y][x] = ''; }
	return g;
}

function cloneGrid(g) {
	var out = [];
	for (var y = 0; y < 6; y++) out[y] = g[y].slice();
	return out;
}

/** The age at which a plant counts as mature, as an integer the plot can hold. */
function matureAge(p) { return Math.max(1, Math.min(99, Math.ceil(p.mature))); }

/* ------------------------------------------------------------------ *
 * Growth, measured in steps
 *
 * Age is the wrong unit for every judgement the assistant makes. The garden
 * rolls its mutations once per step, and a step moves a plant on by
 * ageTick + rand*ageTickR - a number that spans three orders of magnitude
 * across the seed list. Baker's wheat covers eight age in a step and lives
 * twelve steps; elderwort covers half of one and lives a hundred and eighty.
 * Anything expressed in age silently means something different for each.
 * ------------------------------------------------------------------ */

/** Average age gained per step. */
function ageStep(p) { return Math.max(1e-6, p.ageTick + p.ageTickR / 2); }

/** The most age a single step can add - what a margin has to cover. */
function ageStepMax(p) { return Math.max(1e-6, p.ageTick + p.ageTickR); }

/**
 * The age at which the assistant takes a plant it means to keep growing.
 *
 * A plant withers at 100, so it goes on the last step it is certainly still
 * alive - the margin is one of its own steps, not a fixed slice of age. Read
 * in age the two are wildly different: twelve age is a step and a half of
 * baker's wheat but twenty steps of elderwort, and elderwort only matures at
 * 90. A margin like that harvests the late bloomers before they have bred
 * even once, which is exactly the seed they were planted to make.
 */
function harvestAgeOf(p) {
	var margin = ageStepMax(p) * Math.max(0, S.expirySteps);
	return Math.max(matureAge(p), Math.min(99, Math.floor(100 - margin)));
}

/**
 * The share of a replant cycle a plant spends mature, in steps.
 *
 * This is the number the layout scorer was missing. A rule reads neighsM,
 * which counts only neighbours past their own mature age, so a neighbour is
 * worth its odds of being there - 0.6 for baker's wheat, a tenth of that for
 * a late bloomer on a slow tick. An immortal never cycles, so it is always in.
 */
function matureOdds(p) {
	if (p.immortal) return 1;
	var tick = ageStep(p);
	var toHarvest = Math.max(1, Math.ceil(harvestAgeOf(p) / tick));
	var toMature  = Math.ceil(matureAge(p) / tick);
	// A plant is mature for at least the step it crosses the line, and the
	// cycle carries one more step for the tile to be replanted.
	return Math.max(1, toHarvest - toMature) / (toHarvest + 1);
}

function fmtPct(v) {
	if (v >= 0.1) return (v * 100).toFixed(0) + '%';
	if (v >= 0.01) return (v * 100).toFixed(1) + '%';
	return (v * 100).toFixed(2) + '%';
}

/**
 * A breeding rate worth reading. Once maturity is priced in, most recipes sit
 * well below a hundredth of a mutation per step, where a decimal is all
 * zeroes - and "one every 300 steps" is the thing worth knowing anyway, since
 * a step is minutes.
 */
function fmtRate(v) {
	if (!(v > 0)) return 'nothing yet - no route from what is planted';
	if (v >= 0.01) return v.toFixed(3) + ' of this seed per garden step';
	return 'one of this seed about every ' + Math.round(1 / v) + ' garden steps';
}

function fmtCookies(n) {
	if (typeof Beautify === 'function') return Beautify(n);
	return Math.round(n).toString();
}

/* ------------------------------------------------------------------ *
 * Recipes, read out of the game
 * ------------------------------------------------------------------ */

/**
 * getMuts wants two count maps: everything adjacent, and the mature subset.
 * Probing with both set equal means every rule fires that would fire for a
 * fully grown neighbourhood, which is the only kind worth planning for - and
 * it still exposes the ceilings, because those are written against `neighs`.
 */
function probeMuts(m, counts) {
	var neighs = {}, neighsM = {};
	for (var k in m.plants) { neighs[k] = 0; neighsM[k] = 0; }
	for (var k in counts) { neighs[k] = counts[k]; neighsM[k] = counts[k]; }
	return m.getMuts(neighs, neighsM);
}

function parentsKey(parents) {
	var parts = [];
	for (var i = 0; i < parents.length; i++) parts.push(parents[i].key + ':' + parents[i].n);
	return parts.sort().join('+');
}

/** Is `a` satisfied by anything that satisfies `b`? (a needs no more than b) */
function coveredBy(a, b) {
	for (var i = 0; i < a.length; i++) {
		var need = a[i], got = 0;
		for (var j = 0; j < b.length; j++) if (b[j].key === need.key) got = b[j].n;
		if (got < need.n) return false;
	}
	return true;
}

/**
 * No rule in getMuts names more than two species, so singles and pairs recover
 * the whole table. Roughly 15,000 probes, which is a few tens of milliseconds
 * once, at startup.
 */
function buildRecipes(m) {
	var keys = [];
	for (var k in m.plants) keys.push(k);

	var found = {};

	function record(target, chance, parents) {
		var list = found[target] || (found[target] = []);
		for (var i = 0; i < list.length; i++) {
			// An existing recipe that asks for no more and pays no less wins.
			if (coveredBy(list[i].parents, parents) && list[i].chance >= chance) return;
		}
		var kept = [];
		for (var i = 0; i < list.length; i++) {
			if (!(coveredBy(parents, list[i].parents) && chance >= list[i].chance)) kept.push(list[i]);
		}
		kept.push({target:target, chance:chance, parents:parents, ceilings:{}});
		found[target] = kept;
	}

	function harvestProbe(counts, parents) {
		var muts = probeMuts(m, counts);
		// Two rules can offer the same target; each is an independent roll.
		var best = {};
		for (var i = 0; i < muts.length; i++) {
			var t = muts[i][0], p = muts[i][1];
			best[t] = 1 - (1 - (best[t] || 0)) * (1 - p);
		}
		for (var t in best) record(t, best[t], parents);
	}

	for (var i = 0; i < keys.length; i++) {
		for (var c = 1; c <= 8; c++) {
			var counts = {}; counts[keys[i]] = c;
			harvestProbe(counts, [{key:keys[i], n:c}]);
		}
	}
	for (var i = 0; i < keys.length; i++) {
		for (var j = i + 1; j < keys.length; j++) {
			for (var c1 = 1; c1 <= 7; c1++) {
				for (var c2 = 1; c1 + c2 <= 8; c2++) {
					var counts = {}; counts[keys[i]] = c1; counts[keys[j]] = c2;
					harvestProbe(counts, [{key:keys[i], n:c1}, {key:keys[j], n:c2}]);
				}
			}
		}
	}

	// Ceilings: some rules stop firing once the parent is too common, which is
	// what keeps a layout from simply being "as many as will fit". Detected by
	// walking the count up until the recipe disappears.
	for (var t in found) {
		var list = found[t];
		for (var r = 0; r < list.length; r++) {
			var rec = list[r];
			for (var pi = 0; pi < rec.parents.length; pi++) {
				var par = rec.parents[pi], ceil = 8;
				for (var n = par.n + 1; n <= 8; n++) {
					var counts = {};
					for (var pj = 0; pj < rec.parents.length; pj++) {
						counts[rec.parents[pj].key] = rec.parents[pj].n;
					}
					counts[par.key] = n;
					var total = 0;
					for (var ck in counts) total += counts[ck];
					if (total > 8) break;
					var muts = probeMuts(m, counts), still = false;
					for (var mi = 0; mi < muts.length; mi++) if (muts[mi][0] === t) still = true;
					if (!still) { ceil = n - 1; break; }
				}
				if (ceil < 8) rec.ceilings[par.key] = ceil;
			}
		}
		list.sort(function (a, b) { return b.chance - a.chance; });
	}

	return found;
}

function ensureRecipes(m) {
	if (recipes) return recipes;
	recipes = buildRecipes(m);
	return recipes;
}

/** Can every parent of this recipe actually be sown right now? */
function recipeGrowable(m, rec) {
	for (var i = 0; i < rec.parents.length; i++) {
		var p = m.plants[rec.parents[i].key];
		if (!p || !p.unlocked || !p.plantable) return false;
	}
	return true;
}

function bestRecipeFor(m, targetKey) {
	var list = ensureRecipes(m)[targetKey];
	if (!list) return null;
	for (var i = 0; i < list.length; i++) if (recipeGrowable(m, list[i])) return list[i];
	return null;
}

function lockedSeeds(m) {
	var out = [];
	for (var k in m.plants) if (!m.plants[k].unlocked) out.push(k);
	return out;
}

function unlockedCount(m) {
	var n = 0;
	for (var k in m.plants) if (m.plants[k].unlocked) n++;
	return n;
}

/**
 * How many still-missing seeds would become sowable if this one were banked?
 * A seed counts only if every other parent of the route is already in hand -
 * otherwise unlocking this one changes nothing on its own.
 */
function unblockCount(m, key) {
	var table = ensureRecipes(m), n = 0;
	for (var t in m.plants) {
		if (t === key || m.plants[t].unlocked) continue;
		var list = table[t] || [];
		for (var i = 0; i < list.length; i++) {
			var uses = false, blocked = false;
			for (var j = 0; j < list[i].parents.length; j++) {
				var pk = list[i].parents[j].key;
				if (pk === key) uses = true;
				else if (!m.plants[pk].unlocked || !m.plants[pk].plantable) blocked = true;
			}
			if (uses && !blocked) { n++; break; }
		}
	}
	return n;
}

/**
 * Picking the missing seed with the best odds is the obvious rule and it gets
 * stuck: it finds whatever is cheapest to roll and grinds on it, while the
 * branches that would open a dozen more seeds sit untouched behind a parent it
 * never farms. Scoring by chance x what the seed unblocks fixes that - a 1%
 * seed that opens four others beats a 5% dead end.
 */
function bestTarget(m) {
	var missing = lockedSeeds(m), best = null, bestScore = 0;
	for (var i = 0; i < missing.length; i++) {
		var rec = bestRecipeFor(m, missing[i]);
		if (!rec) continue;
		var score = rec.chance * (1 + unblockCount(m, missing[i]));
		if (score > bestScore) { bestScore = score; best = missing[i]; }
	}
	return {key: best, score: bestScore};
}

/**
 * What an empty plot is worth, in the same units as a breeding target.
 *
 * This has to compete rather than wait its turn. Once the seeds reachable
 * without fungus are banked there is usually still *something* sowable - from
 * a plot of elderwort, shriekbulb is offered at 0.1% - so a "nursery only when
 * nothing else is growable" rule never fires, and the assistant grinds a dead
 * end forever while fifteen seeds sit behind a weed it refuses to farm.
 *
 * The weed sprouts at 0.002 * weedMult per bare, wholly isolated tile, and
 * uprooting it ripe returns a spore about 18% of the time.
 */
function nurseryScore(m) {
	var gain = 0;
	// The weed itself is read off the game's own flag; the fungi it drops are
	// hardcoded in M.harvest, so their names are checked against the garden
	// rather than trusted - a renamed plant degrades this to zero instead of
	// throwing and silently killing Breed.
	for (var k in m.plants) {
		if (m.plants[k].weed && !m.plants[k].unlocked) gain += 1;
	}
	var spores = ['brownMold', 'crumbspore'];
	for (var i = 0; i < spores.length; i++) {
		var sp = m.plants[spores[i]];
		if (sp && !sp.unlocked) gain += 1 + unblockCount(m, spores[i]);
	}
	if (!gain) return 0;
	// The gate is deliberately binary, not a scale-down: the nursery clears
	// the plot itself, so what stands on it today says nothing about how many
	// weeds it will host - except for immortals, which nothing ever clears.
	// Scaling by today's occupancy just delays the nursery while the planner
	// keeps planting elderwort, which is how a plot becomes unweedable.
	if (!nurseryCapacity(m)) return 0;
	var weedMult = m.soilsById[m.soil].weedMult;
	return 0.002 * weedMult * 0.2 * (S.ripenWeeds / 100) * gain;
}

/**
 * How many unlocked tiles could ever host a weed. The game sprouts meddleweed
 * only in a tile with no neighbours at all, and the nursery can clear anything
 * except an immortal - so a tile counts unless an immortal sits on it or on
 * one of its eight neighbours. Scattered elderwort can push this to zero, and
 * a nursery that cannot produce a single weed is not a plan, it is a deadlock.
 */
function nurseryCapacity(m) {
	var tiles = unlockedTiles(m), n = 0;
	for (var t = 0; t < tiles.length; t++) {
		var x = tiles[t][0], y = tiles[t][1], blocked = false;
		for (var dy = -1; dy <= 1 && !blocked; dy++) {
			for (var dx = -1; dx <= 1; dx++) {
				var xx = x + dx, yy = y + dy;
				if (xx < 0 || xx > 5 || yy < 0 || yy > 5) continue;
				var p = plantOf(m, m.plot[yy][xx]);
				if (p && p.immortal) { blocked = true; break; }
			}
		}
		if (!blocked) n++;
	}
	return n;
}

/**
 * The one decision Breed mode makes each time the plot or the collection
 * changes: work towards a seed, or clear the plot and farm the weed. Shared by
 * the planner and by the cache key, so the two can never disagree.
 */
function decideBreed(m) {
	if (!lockedSeeds(m).length) return {done: true};

	// An explicit pick from the dropdown is obeyed, nursery or not.
	if (S.target && m.plants[S.target] && !m.plants[S.target].unlocked) {
		var rec = bestRecipeFor(m, S.target);
		if (rec) return {target: S.target, recipe: rec};
	}

	var bt = bestTarget(m);
	var ns = nurseryScore(m);
	if (ns > bt.score) return {nursery: true};
	if (!bt.key) {
		// Nothing sowable leads anywhere new. The nursery is the way out -
		// unless immortals have made a weed impossible, in which case saying
		// so beats waiting forever for one.
		if (ns > 0) return {nursery: true};
		return {stuck: true};
	}
	return {target: bt.key, recipe: bestRecipeFor(m, bt.key)};
}

/** The seed the panel should show as the current goal, if there is one. */
function suggestTarget(m) {
	return bestTarget(m).key;
}

function recipeText(m, rec) {
	if (!rec) return 'no route you can sow yet';
	var parts = [];
	for (var i = 0; i < rec.parents.length; i++) {
		var p = rec.parents[i];
		parts.push(p.n + 'x mature ' + m.plants[p.key].name);
	}
	return parts.join(' + ') + '  next to an empty tile';
}

/* ------------------------------------------------------------------ *
 * Scoring a layout
 * ------------------------------------------------------------------ */

/**
 * The game rolls every mutation the neighbourhood offers, keeps the ones that
 * passed, and plants exactly one of them chosen uniformly. So a target's real
 * chance of landing is not its own rate: it is that rate times the share it
 * gets when k rival rolls also passed. k is a small Poisson-binomial, so the
 * exact expectation is cheaper to convolve than to sample.
 *
 * That matters for the rare seeds. Bakeberry is offered at 0.1% off two mature
 * baker's wheat - but the same neighbourhood offers wheat at 20% and thumbcorn
 * at 5%, and those crowd it out of the draw about a quarter of the time.
 */
function landChance(muts, targetKey) {
	var pT = 0, others = [];
	for (var i = 0; i < muts.length; i++) {
		if (muts[i][0] === targetKey) pT = 1 - (1 - pT) * (1 - muts[i][1]);
		else others.push(muts[i][1]);
	}
	if (pT <= 0) return 0;

	var dist = [1];
	for (var i = 0; i < others.length; i++) {
		var p = others[i], next = [];
		for (var k = 0; k <= dist.length; k++) next[k] = 0;
		for (var k = 0; k < dist.length; k++) {
			next[k]     += dist[k] * (1 - p);
			next[k + 1] += dist[k] * p;
		}
		dist = next;
	}
	var share = 0;
	for (var k = 0; k < dist.length; k++) share += dist[k] / (1 + k);
	return pT * share;
}

/**
 * What stands next to a tile in a plan - the count of each species, whatever
 * its age. Maturity is not decided here: which of those neighbours happen to
 * be grown at any one step is a question of odds, and expectedChance answers
 * it. Returns null for a tile with no neighbours at all.
 */
function neighbourhoodOf(m, grid, x, y) {
	var neighs = {}, any = 0;
	for (var k in m.plants) neighs[k] = 0;
	for (var dy = -1; dy <= 1; dy++) {
		for (var dx = -1; dx <= 1; dx++) {
			if (dx === 0 && dy === 0) continue;
			var nx = x + dx, ny = y + dy;
			if (nx < 0 || nx > 5 || ny < 0 || ny > 5) continue;
			if (!m.isTileUnlocked(nx, ny)) continue;
			var key = grid[ny][nx];
			if (!key) continue;
			any++; neighs[key]++;
		}
	}
	return any > 0 ? neighs : null;
}

/** The old reading: what the tile offers if every neighbour is fully grown. */
function snapshotChance(m, neighs, targetKey) {
	return landChance(m.getMuts(neighs, neighs), targetKey);
}

/**
 * A neighbour count map the game will accept: every species named, because
 * several rules cap a species (neighs['clover'] < 5) and an absent key fails
 * that test rather than passing it.
 */
function fillCounts(m, counts) {
	var out = {};
	for (var k in m.plants) out[k] = 0;
	for (var k in counts) if (out[k] !== undefined) out[k] = counts[k];
	return out;
}

/** C(n, k), for n no larger than the eight tiles around one square. */
function choose(n, k) {
	var r = 1;
	for (var i = 0; i < k; i++) r = r * (n - i) / (i + 1);
	return r;
}

var chanceCache = {};

/**
 * What a tile really offers per step, averaged over the cycle its neighbours
 * are actually living.
 *
 * Scoring the fully-grown snapshot prices a state the garden rarely occupies,
 * and it is wrong by a different factor for every rule. A neighbour required
 * only by count (neighs) costs nothing at all - shriekbulb off three
 * duketaters does not care how old they are. A neighbour required grown
 * (neighsM) is worth its odds of being grown, and a rule naming two of them
 * needs both windows open at the same time. That last case is where the
 * snapshot fails hardest, because the parents rarely grow at the same speed:
 * everdaisy wants three mature tidygrass and three mature elderwort, and
 * tidygrass cycles twice in the time elderwort takes just to come of age.
 *
 * Each species' grown copies are drawn independently - which is the honest
 * assumption for neighbours on different clocks, replanted as tiles free up
 * rather than in lockstep - so the count grown is binomial and the states are
 * few enough to enumerate exactly. The score of a state is the game's own
 * verdict on it: getMuts, then the same crowding-out share as ever.
 */
function expectedChance(m, neighs, targetKey) {
	var keys = [], k;
	for (k in neighs) if (neighs[k] > 0) keys.push(k);
	if (!keys.length) return 0;
	keys.sort();

	var ck = targetKey + '|';
	for (var i = 0; i < keys.length; i++) ck += keys[i] + neighs[keys[i]];
	if (chanceCache[ck] !== undefined) return chanceCache[ck];

	// Per species: the chance that exactly i of its copies are grown.
	var weights = [];
	for (i = 0; i < keys.length; i++) {
		var n = neighs[keys[i]], q = matureOdds(m.plants[keys[i]]), w = [];
		for (var j = 0; j <= n; j++) w[j] = choose(n, j) * Math.pow(q, j) * Math.pow(1 - q, n - j);
		weights.push(w);
	}

	var neighsM = {};
	for (k in neighs) neighsM[k] = 0;

	var total = 0;
	(function walk(i, weight) {
		if (weight < 1e-12) return;                     // a state too rare to matter
		if (i === keys.length) {
			total += weight * landChance(m.getMuts(neighs, neighsM), targetKey);
			return;
		}
		for (var j = 0; j <= neighs[keys[i]]; j++) {
			neighsM[keys[i]] = j;
			walk(i + 1, weight * weights[i][j]);
		}
		neighsM[keys[i]] = 0;
	})(0, 1);

	chanceCache[ck] = total;
	return total;
}

function scoreBreedPlan(m, grid, tiles, targetKey) {
	var total = 0;
	for (var t = 0; t < tiles.length; t++) {
		var x = tiles[t][0], y = tiles[t][1];
		if (grid[y][x]) continue;                       // mutations land on empty tiles only
		var neighs = neighbourhoodOf(m, grid, x, y);
		if (!neighs) continue;
		total += expectedChance(m, neighs, targetKey);
	}
	return total;
}

/* ------------------------------------------------------------------ *
 * Layout planning
 * ------------------------------------------------------------------ */

/**
 * Starting shapes for the hill climb. The classic hand-drawn garden layouts
 * are all in here somewhere - a checkerboard, alternating rows, alternating
 * columns - and the climb refines whichever fits the plot you actually have
 * unlocked, which is rarely the full 6x6.
 */
function seedGrids(tiles, species) {
	var grids = [];

	// The ring shapes below need the bounds of whatever part of the plot is
	// actually unlocked, which is rarely the full 6x6.
	var minX = 6, maxX = -1, minY = 6, maxY = -1;
	for (var t = 0; t < tiles.length; t++) {
		if (tiles[t][0] < minX) minX = tiles[t][0];
		if (tiles[t][0] > maxX) maxX = tiles[t][0];
		if (tiles[t][1] < minY) minY = tiles[t][1];
		if (tiles[t][1] > maxY) maxY = tiles[t][1];
	}
	var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

	var patterns = [
		function () { return -1; },                                 // all empty
		function (x, y) { return ((x + y) % 2 === 0) ? 0 : -1; },   // checkerboard
		function (x, y) { return (y % 2 === 0) ? 0 : -1; },         // rows
		function (x, y) { return (x % 2 === 0) ? 0 : -1; },         // columns
		function (x, y) { return ((x + y) % 3 === 0) ? -1 : 0; },   // dense, holes on a diagonal
		function (x, y) { return (x % 2 === 0 && y % 2 === 0) ? 0 : -1; },

		// Solid but for isolated single-tile holes, so every hole has all eight
		// neighbours filled. Without a start like this the recipes that want
		// many of one parent at once are unreachable: Juicy queenbeet needs
		// eight mature queenbeets around one tile, and until all eight are down
		// the score is flat zero, so no single-tile change can ever look like an
		// improvement and the climb never leaves the empty plot. Two offsets,
		// because which holes fit depends on how much of the plot is unlocked.
		function (x, y) { return (x % 3 === 1 && y % 3 === 1) ? -1 : 0; },
		function (x, y) { return (x % 3 === 2 && y % 3 === 2) ? -1 : 0; },

		// A border with a filled core, leaving a moat of empty tiles between
		// them. Every moat tile sees plants on both sides, which is what the
		// five-and-up recipes want - the community charts draw exactly this for
		// Shriekbulb, and hill climbing does not stumble onto a ring on its own.
		function (x, y) {
			var border = (x === minX || x === maxX || y === minY || y === maxY);
			var core = Math.abs(x - cx) <= 0.5 && Math.abs(y - cy) <= 0.5;
			return (border || core) ? 0 : -1;
		},
		// The same idea one ring further in, for plots too small for a moat.
		function (x, y) {
			var border = (x === minX || x === maxX || y === minY || y === maxY);
			var core = Math.abs(x - cx) <= 1.5 && Math.abs(y - cy) <= 1.5;
			return (border || core) ? 0 : -1;
		}
	];
	for (var p = 0; p < patterns.length; p++) {
		var g = emptyGrid(), alt = 0;
		for (var t = 0; t < tiles.length; t++) {
			var x = tiles[t][0], y = tiles[t][1];
			var pick = patterns[p](x, y);
			if (pick < 0) continue;
			// With two parents, alternate them along the pattern so both are
			// adjacent to the same holes.
			g[y][x] = species[species.length > 1 ? (alt++ % species.length) : 0];
		}
		grids.push(g);
	}
	return grids;
}

/**
 * Hill climbing over one tile at a time. The plot is at most 36 tiles and the
 * alphabet is at most three symbols (empty plus two parents), so this converges
 * in a handful of passes and there is nothing to be gained from anything
 * cleverer.
 */
function climb(tiles, alphabet, score, start, maxPasses) {
	var grid = cloneGrid(start), best = score(grid);
	for (var pass = 0; pass < maxPasses; pass++) {
		var improved = false;
		for (var t = 0; t < tiles.length; t++) {
			var x = tiles[t][0], y = tiles[t][1];
			var was = grid[y][x], bestCand = was, bestScore = best;
			for (var a = 0; a < alphabet.length; a++) {
				if (alphabet[a] === was) continue;
				grid[y][x] = alphabet[a];
				var sc = score(grid);
				if (sc > bestScore + 1e-12) { bestScore = sc; bestCand = alphabet[a]; }
			}
			grid[y][x] = bestCand;
			if (bestCand !== was) { best = bestScore; improved = true; }
		}
		if (!improved) break;
	}
	return {grid:grid, score:best};
}

function planBreed(m, rec) {
	var tiles = unlockedTiles(m);
	var species = [];
	for (var i = 0; i < rec.parents.length; i++) species.push(rec.parents[i].key);

	var alphabet = [''].concat(species);
	var score = function (g) { return scoreBreedPlan(m, g, tiles, rec.target); };

	var best = null;
	var starts = seedGrids(tiles, species);
	for (var s = 0; s < starts.length; s++) {
		var out = climb(tiles, alphabet, score, starts[s], 8);
		if (!best || out.score > best.score) best = out;
	}
	return {
		grid:  best.grid,
		score: best.score,
		key:   'breed:' + rec.target + ':' + parentsKey(rec.parents),
		label: 'Breeding ' + m.plants[rec.target].name
	};
}

/* ------------------------------------------------------------------ *
 * Boost layouts
 * ------------------------------------------------------------------ */

/**
 * Runs `fn` against a scratch plot and puts the real garden back. The game
 * caches its effect numbers, so both caches are rebuilt from the restored plot
 * on the way out - otherwise the bonuses on your screen would be whatever the
 * last probe happened to leave behind.
 */
function withScratch(m, fn) {
	var saved = [];
	for (var y = 0; y < 6; y++) {
		saved[y] = [];
		for (var x = 0; x < 6; x++) saved[y][x] = [m.plot[y][x][0], m.plot[y][x][1]];
	}
	try {
		return fn();
	} finally {
		for (var y = 0; y < 6; y++) {
			for (var x = 0; x < 6; x++) m.plot[y][x] = saved[y][x];
		}
		m.computeBoostPlot();
		m.computeEffs();
	}
}

function applyGridToPlot(m, grid) {
	for (var y = 0; y < 6; y++) {
		for (var x = 0; x < 6; x++) {
			var key = m.isTileUnlocked(x, y) ? grid[y][x] : '';
			if (!key) { m.plot[y][x] = [0, 0]; continue; }
			var p = m.plants[key];
			m.plot[y][x] = [p.id + 1, matureAge(p)];
		}
	}
}

function objectiveValue(m, obj) {
	m.computeBoostPlot();
	m.computeEffs();
	var v = m.effs[obj.eff];
	if (typeof v !== 'number') v = 1;
	return obj.rev ? -v : v;
}

/**
 * Candidates are narrowed before the climb: a species that does nothing for
 * the chosen bonus on its own can still earn a place, but only if it helps its
 * neighbours, so the shortlist is "moves the number alone" plus "moves the
 * number when it surrounds something else". That second test is what finds
 * nursetulip, which is useless by itself and lifts every neighbour by 20%.
 */
function boostCandidates(m, obj) {
	var out = [];
	withScratch(m, function () {
		var tiles = unlockedTiles(m);
		if (tiles.length < 2) return;
		var centre = tiles[Math.floor(tiles.length / 2)];

		var grid = emptyGrid();
		applyGridToPlot(m, grid);
		var base = objectiveValue(m, obj);

		var soloBest = null, soloBestVal = base;
		for (var k in m.plants) {
			var p = m.plants[k];
			if (!p.unlocked || !p.plantable || p.weed) continue;
			grid = emptyGrid();
			grid[centre[1]][centre[0]] = k;
			applyGridToPlot(m, grid);
			var v = objectiveValue(m, obj);
			if (v > base + 1e-12) {
				out.push(k);
				if (v > soloBestVal) { soloBestVal = v; soloBest = k; }
			}
		}
		// Second pass: helpers, judged by what they do around the best solo plant.
		if (soloBest) {
			for (var k in m.plants) {
				var p = m.plants[k];
				if (!p.unlocked || !p.plantable || p.weed) continue;
				var already = false;
				for (var i = 0; i < out.length; i++) if (out[i] === k) already = true;
				if (already) continue;

				grid = emptyGrid();
				grid[centre[1]][centre[0]] = soloBest;
				applyGridToPlot(m, grid);
				var withoutHelper = objectiveValue(m, obj);

				for (var dy = -1; dy <= 1; dy++) {
					for (var dx = -1; dx <= 1; dx++) {
						if (dx === 0 && dy === 0) continue;
						var nx = centre[0] + dx, ny = centre[1] + dy;
						if (nx < 0 || nx > 5 || ny < 0 || ny > 5) continue;
						if (m.isTileUnlocked(nx, ny)) grid[ny][nx] = k;
					}
				}
				applyGridToPlot(m, grid);
				if (objectiveValue(m, obj) > withoutHelper + 1e-12) out.push(k);
			}
		}
	});
	return out;
}

function planBoost(m, objKey) {
	var obj = objectiveByKey(objKey);
	var species = boostCandidates(m, obj);
	if (!species.length) return null;

	var tiles = unlockedTiles(m);
	var result = withScratch(m, function () {
		var score = function (g) { applyGridToPlot(m, g); return objectiveValue(m, obj); };
		var alphabet = [''].concat(species);

		// Start from each candidate used uniformly; the climb mixes in helpers.
		var best = null;
		for (var s = 0; s < species.length; s++) {
			var g = emptyGrid();
			for (var t = 0; t < tiles.length; t++) g[tiles[t][1]][tiles[t][0]] = species[s];
			var out = climb(tiles, alphabet, score, g, 4);
			if (!best || out.score > best.score) best = out;
		}
		return best;
	});
	if (!result) return null;

	// Report the bonus the way the game's own tooltip does: the raw multiplier
	// minus one. For a cost that means a negative number, which is the good
	// direction - buildings at 0.92 read as -8%.
	var pct = (obj.rev ? -result.score : result.score) - 1;
	return {
		grid:  result.grid,
		score: result.score,
		pct:   pct,
		key:   'boost:' + objKey + ':' + tiles.length,
		label: obj.label
	};
}

/* ------------------------------------------------------------------ *
 * Keeping the plan current
 * ------------------------------------------------------------------ */

function currentTarget(m) {
	if (S.target && m.plants[S.target] && !m.plants[S.target].unlocked) return S.target;
	return suggestTarget(m);
}

function wantedPlanKey(m) {
	if (S.mode === 'breed') {
		var d = decideBreed(m);
		if (d.done) return 'breed:done';
		// Capacity is part of the key so a hand-harvested immortal, or anything
		// else that frees a corner, triggers a re-plan on the next step.
		if (d.stuck) return 'breed:stuck:' + unlockedTiles(m).length + ':' + nurseryCapacity(m);
		if (d.nursery || !d.recipe) return 'breed:nursery';
		return 'breed:' + d.target + ':' + parentsKey(d.recipe.parents) + ':' + unlockedTiles(m).length;
	}
	if (S.mode === 'boost') return 'boost:' + S.objective + ':' + unlockedTiles(m).length;
	return 'none';
}

/**
 * When nothing you can sow leads anywhere new, the way forward is not a
 * layout - it is an empty plot.
 *
 * Meddleweed is the gateway to the whole fungus half of the tree, and the game
 * only sprouts a weed in a tile that has no neighbours at all
 * (minigameGarden.js, the `any == 0` branch of the step). A tidy, fully
 * planted garden therefore locks that half of the collection away forever. So
 * the assistant deliberately clears the plot, waits for meddleweed, and lets
 * it ripen before uprooting it, because the spore it drops on being pulled is
 * worth 0.2 * age/100 - about 18% at age 90 against 10% at maturity.
 */
function nurseryPlan(key) {
	return {
		grid:    emptyGrid(),
		score:   0,
		nursery: true,
		key:     key,
		label:   'Nursery'
	};
}

function rebuildPlan(m, force) {
	var want = wantedPlanKey(m);
	if (!force && plan && plan.key === want) return plan;

	if (S.mode === 'breed') {
		var d = decideBreed(m);
		if (d.done) {
			plan = null;
			statusText = 'every seed is banked - nothing left to breed';
			return null;
		}
		if (d.stuck) {
			plan = {stuck: true, key: want, grid: null, score: 0, label: 'Stuck'};
			statusText = STUCK_MSG;
			return plan;
		}
		if (d.nursery || !d.recipe) {
			plan = nurseryPlan(want);
			statusText = 'nursery: clearing the plot so meddleweed can sprout';
			return plan;
		}
		plan = planBreed(m, d.recipe);
		plan.recipe = d.recipe;
		plan.target = d.target;
		plan.key = want;
	} else if (S.mode === 'boost') {
		plan = planBoost(m, S.objective);
		if (plan) plan.key = want;
	} else {
		plan = null;
	}
	return plan;
}

/* ------------------------------------------------------------------ *
 * Acting on a garden step
 * ------------------------------------------------------------------ */

function harvestAt(m, x, y) {
	var p = plantOf(m, m.plot[y][x]);
	if (!p) return false;
	var wasLocked = !p.unlocked;
	var mature = m.plot[y][x][1] >= p.mature;
	if (!m.harvest(x, y, 0)) return false;
	stats.harvested++;
	if (wasLocked && mature) stats.banked++;
	if (p.weed) stats.uprooted++;
	return true;
}

function plantAt(m, p, x, y, budget) {
	var cost = m.getCost(p);
	if (cost > budget || Game.cookies < cost) return 0;
	m.plot[y][x] = [p.id + 1, 0];
	if (cost > 0) Game.Spend(cost);
	m.toRebuild = true;
	m.toCompute = true;
	stats.planted++;
	return cost;
}

/**
 * The plants the current layout wants gone, worked out without touching
 * anything. The panel asks about exactly this list and runStep acts on exactly
 * this list, so the question and the action cannot drift apart.
 *
 * Deliberately excluded, because none of them is a loss the player would
 * regret: weeds (worthless, and governed by their own setting), immortals
 * (never uprooted at all), species not yet banked (left to ripen), and
 * anything already within the expiry margin - that one was going to die this
 * cycle anyway, so harvesting it is strictly better than letting it rot.
 */
function removalsFor(m) {
	var out = [];
	if (S.mode !== 'breed' && S.mode !== 'boost') return out;
	if (!plan || !plan.grid || !S.keepPlan) return out;

	var grid = plan.grid, nursery = !!plan.nursery, tiles = unlockedTiles(m);
	for (var t = 0; t < tiles.length; t++) {
		var x = tiles[t][0], y = tiles[t][1], tile = m.plot[y][x];
		var p = plantOf(m, tile);
		if (!p || p.immortal || p.weed || !p.unlocked) continue;
		if (grid[y][x] === p.key) continue;

		var age = tile[1], mature = age >= p.mature;
		if (!mature && !nursery) continue;
		if (mature && age >= harvestAgeOf(p)) continue;
		out.push({x: x, y: y, key: p.key, name: p.name, mature: mature});
	}
	return out;
}

/** 'clear', 'keep', or 'ask' for the layout currently on screen. */
function clearanceState() {
	if (!S.askBeforeClearing) return 'clear';
	if (!plan || !plan.key) return 'clear';
	return clearDecision[plan.key] || 'ask';
}

function decideClearance(what) {
	if (plan && plan.key) clearDecision[plan.key] = what;
}

/**
 * One pass over the plot, run once per garden step.
 *
 * Harvest before planting, so a tile freed this step can be refilled this step
 * rather than sitting empty for another five minutes.
 */
function runStep(m) {
	if (S.mode === 'off') { statusText = 'off'; return; }

	var grid = (S.mode === 'breed' || S.mode === 'boost') ? (plan && plan.grid) : null;
	var nursery = !!(plan && plan.nursery);
	var tiles = unlockedTiles(m);
	var t, x, y;

	// Uprooting is the only thing here a player can lose work to, so it is the
	// only thing that waits for an answer.
	var removals = removalsFor(m), clearance = clearanceState(), removeSet = {};
	if (clearance === 'clear') {
		for (t = 0; t < removals.length; t++) removeSet[removals[t].x + ',' + removals[t].y] = 1;
	}
	keptCount = (clearance === 'keep') ? removals.length : 0;

	for (t = 0; t < tiles.length; t++) {
		x = tiles[t][0]; y = tiles[t][1];
		var tile = m.plot[y][x];
		var p = plantOf(m, tile);
		if (!p) continue;
		var age = tile[1], mature = age >= p.mature;

		// A species you have never banked is worth more than any layout.
		if (S.bankNew && mature && !p.unlocked) { harvestAt(m, x, y); continue; }

		// ...and one that has not matured yet is worth more still, because it
		// is about to become one. Harvesting below maturity banks nothing
		// (M.harvest only unlocks at age >= mature), so a mutation the layout
		// did not ask for must be left alone until it ripens - it is the seed
		// the layout exists to produce.
		if (!p.unlocked) continue;

		if (p.weed) {
			// Meddleweed is the gateway to the whole fungus branch: uprooting it
			// drops a spore at 0.2 * age/100, so it is worth letting it ripen
			// first. Only then is it in the way.
			var wanted = grid && grid[y][x] === p.key;
			if (S.pullWeeds && !wanted && age >= S.ripenWeeds) harvestAt(m, x, y);
			continue;
		}

		// Clear what the layout does not want - but only what was approved.
		// Anything still awaiting an answer, or answered with "keep", simply
		// stays where it is; the layout fills in around it as tiles free up on
		// their own.
		if (removeSet[x + ',' + y]) { harvestAt(m, x, y); continue; }

		if (S.harvestMature && mature && age >= harvestAgeOf(p)) { harvestAt(m, x, y); continue; }
	}

	if (nursery) {
		var weeds = 0, bare = 0;
		for (t = 0; t < tiles.length; t++) {
			var tl = m.plot[tiles[t][1]][tiles[t][0]];
			if (!tl[0]) bare++;
			else if (m.plantsById[tl[0] - 1].weed) weeds++;
		}
		statusText = 'nursery: ' + bare + ' bare tiles waiting for meddleweed' +
			(weeds ? ', ' + weeds + ' ripening' : '');
		return;
	}

	if (!grid || !S.keepPlan) {
		// A stuck plot still gets the full pass above - new species are still
		// banked and ripe weeds still pulled - only planting has nothing to do.
		if (plan && plan.stuck) statusText = STUCK_MSG;
		else statusText = (S.mode === 'tend') ? 'tending' : 'no layout - nothing planted';
		return;
	}

	var budget = Game.cookies * S.maxSpendPct, spent = 0, planted = 0, short = 0;
	for (t = 0; t < tiles.length; t++) {
		x = tiles[t][0]; y = tiles[t][1];
		if (m.plot[y][x][0] > 0) continue;
		var key = grid[y][x];
		if (!key) continue;
		var want = m.plants[key];
		if (!want || !want.unlocked || !want.plantable) continue;
		var cost = plantAt(m, want, x, y, budget - spent);
		if (cost > 0 || m.getCost(want) === 0) { spent += cost; planted++; }
		else short++;
	}
	statusText = planted ? ('planted ' + planted + (spent ? ' for ' + fmtCookies(spent) + ' cookies' : ''))
		: (short ? 'waiting for cookies to fill ' + short + ' tiles' : 'layout is planted');
}

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

/**
 * Built rather than declared, because the seed icons reuse the game's own
 * sprite sheet and its URL carries Game.resPath and the cache-busting version.
 */
function buildCSS() {
return [
	'#' + PANEL_ID + '{position:relative;z-index:120;margin:0;padding:8px 24px 10px 24px;',
	'background:rgba(0,0,0,0.82);color:#e8e8e8;font-size:14px;',
	'border-top:1px solid #79c600;box-shadow:0 0 8px rgba(0,0,0,0.6) inset;text-align:left;}',
	'#' + PANEL_ID + ' .ggRow{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:4px 0;}',
	'#' + PANEL_ID + ' .ggTitle{font-weight:bold;color:#94cd50;letter-spacing:1px;}',
	'#' + PANEL_ID + ' .ggVer{font-weight:normal;font-size:10px;letter-spacing:0;opacity:0.55;margin-left:5px;}',
	'#' + PANEL_ID + ' .ggBtn{cursor:pointer;border:1px solid rgba(255,255,255,0.35);border-radius:3px;',
	'padding:1px 9px;font-weight:bold;font-size:13px;background:rgba(255,255,255,0.08);color:#fff;}',
	'#' + PANEL_ID + ' .ggBtn:hover{background:rgba(255,255,255,0.2);}',
	'#' + PANEL_ID + ' .ggBtn.ggOn{background:#94cd50;color:#000;border-color:#cfe9a8;}',
	'#' + PANEL_ID + ' .ggStat{font-size:13px;color:#bbb;}',
	'#' + PANEL_ID + ' .ggStat b{color:#fff;}',
	'#' + PANEL_ID + ' .ggGood{color:#9ed36a;}',
	'#' + PANEL_ID + ' .ggWarn{color:#ffd75e;}',
	'#' + PANEL_ID + ' .ggNote{font-size:12px;color:#9a9a9a;max-width:640px;line-height:1.4;}',
	'#' + PANEL_ID + ' .ggSep{border:0;height:1px;background:#3f3f3f;margin:6px 0;}',
	'#' + PANEL_ID + ' select{background:#1a1a1a;color:#eee;border:1px solid #666;border-radius:3px;',
	'padding:1px 4px;font-size:13px;max-width:260px;}',
	'#' + PANEL_ID + ' label{font-size:13px;color:#ddd;cursor:pointer;}',
	'#' + PANEL_ID + ' .ggSet{display:flex;align-items:center;gap:5px;}',
	'#' + PANEL_ID + ' [title]{cursor:help;}',
	'#' + PANEL_ID + ' .ggBtn[title],#' + PANEL_ID + ' .ggSeed[title]{cursor:pointer;}',
	// The plan preview: one small square per tile, laid out as the plot is.
	'#' + PANEL_ID + ' .ggGrid{display:grid;grid-template-columns:repeat(6,14px);grid-gap:2px;}',
	'#' + PANEL_ID + ' .ggCell{width:14px;height:14px;border-radius:2px;background:rgba(255,255,255,0.05);',
	'border:1px solid rgba(255,255,255,0.12);}',
	'#' + PANEL_ID + ' .ggCell.ggLocked{background:transparent;border-color:transparent;}',
	'#' + PANEL_ID + ' .ggCell.ggHole{background:rgba(255,255,255,0.03);border-style:dashed;}',
	'#' + PANEL_ID + ' .ggLegend{display:flex;align-items:center;gap:5px;font-size:12px;color:#bbb;}',
	'#' + PANEL_ID + ' .ggSwatch{width:11px;height:11px;border-radius:2px;display:inline-block;',
	'border:1px solid rgba(255,255,255,0.25);}',

	// The seed picker: the game's own seed-packet icons, one per missing seed.
	'#' + PANEL_ID + ' .ggSeedGrid{display:flex;flex-wrap:wrap;gap:3px;max-width:600px;}',
	'#' + PANEL_ID + ' .ggSeed{position:relative;width:30px;height:30px;cursor:pointer;',
	'border:1px solid rgba(255,255,255,0.15);border-radius:4px;overflow:hidden;',
	'background:rgba(255,255,255,0.05);}',
	'#' + PANEL_ID + ' .ggSeed:hover{border-color:#94cd50;background:rgba(148,205,80,0.18);}',
	'#' + PANEL_ID + ' .ggSeed.ggSel{border-color:#94cd50;background:rgba(148,205,80,0.32);',
	'box-shadow:0 0 5px rgba(148,205,80,0.75);}',
	// Dimmed rather than hidden: knowing a seed exists but is not yet reachable
	// is the useful half of the picture.
	'#' + PANEL_ID + ' .ggSeed.ggBlocked .ggSeedIcon{opacity:0.3;filter:grayscale(1);}',
	// Column 0 of gardenPlants.png is the seed packet; the row is plant.icon.
	// Scaled from the sheet's 48px cell to the 30px tile.
	'#' + PANEL_ID + ' .ggSeedIcon{position:absolute;left:0;top:0;width:48px;height:48px;',
	'pointer-events:none;transform:scale(0.625);transform-origin:0 0;',
	'background:url(' + spriteURL() + ');}',
	'#' + PANEL_ID + ' .ggAuto{width:auto;min-width:34px;padding:0 5px;display:flex;',
	'align-items:center;justify-content:center;font-size:11px;font-weight:bold;color:#ddd;}',

	// The one question the assistant ever asks, so it is allowed to be loud.
	'#' + PANEL_ID + ' .ggAlert{background:rgba(210,140,40,0.16);border:1px solid #c8912e;',
	'border-radius:4px;padding:5px 9px;margin:5px 0;}',
	'#' + PANEL_ID + ' .ggAlert .ggBtn{border-color:#e0b060;}',
	'#' + PANEL_ID + ' .ggAlertText{color:#ffd75e;font-size:13px;}'
].join('');
}

/** The game's plant sprite sheet, cache-busted the way the game does it. */
function spriteURL() {
	var base = (typeof Game !== 'undefined' && Game.resPath) ? Game.resPath : '';
	var ver  = (typeof Game !== 'undefined' && Game.version) ? Game.version : '';
	return base + 'img/gardenPlants.png?v=' + ver;
}

// Distinct, colour-blind-safe enough for the two or three species a plan uses.
var PLAN_COLORS = ['#4fa3d1', '#e0a03c', '#7bc25c', '#c56ec5', '#d1584f'];

/**
 * Hover text, kept in one place so the panel markup stays readable and every
 * explanation is written once. The modes carry their own hint already; these
 * are for the controls and readouts around them.
 */
var HELP = {
	progress: 'How many of the 34 species you have banked, and how much of your unlocked plot is currently growing something.',
	settings: 'Toggles for what the assistant may do on its own.',
	replan:   'Work the layout out again from scratch. Useful after your farm levels up and the plot gets bigger, or if you changed soil.',
	breed:    'The seed being worked towards. Pick one yourself, or leave it on Auto and the assistant chooses - it ranks by chance times how many further seeds the pick would unblock, rather than by raw odds, because chasing the best odds alone gets stuck.',
	boost:    'Which bonus to maximise. The layout is scored by running the game\'s own effect calculation on it, so plot interactions and penalties are exact.',
	layout:   'What the assistant wants planted. One colour per species; dashed squares are deliberately left empty, because mutations can only land on an empty tile. Blank squares are tiles your farm level has not unlocked yet. Hover a square for the plant.',
	yield:    'How many of the target seed this layout is expected to produce per garden step, averaged over the cycle the plants really live. It accounts for rival mutations crowding the tile - the game plants only one winner per tile, chosen at random from everything that rolled successfully - and for the fact that a plant only counts as a parent while it is mature, which for a slow grower is a small part of its life.',
	step:     'The garden only changes on a step - every 5 minutes on dirt, 3 on fertilizer, 15 on clay. The assistant acts then and does nothing in between.',
	clearYes: 'Uproot them now and plant the layout. Mature ones still bank their seed as they go.',
	clearNo:  'Leave them growing. The layout fills in around them as tiles free up on their own, and you will not be asked again for this layout.',
	clearRow: 'The assistant will not take a plant you might still want without asking. This question covers only plants that would otherwise keep living - weeds, immortals, species you have not banked yet and anything already about to expire are never part of it.',
	setBank:  'A species you have never banked is worth more than any layout, so it is harvested the moment it matures. This is the only thing that actually unlocks a seed - harvesting early banks nothing.',
	setMature:'Take a mature plant on the last step it is certainly still alive, so the tile frees up instead of rotting. The margin is one of the plant\'s own growth steps, not a fixed slice of age: baker\'s wheat covers eight age in a step and a duketater half of one, and a duketater is not even mature until 95.',
	setPlan:  'Sow the layout into empty tiles as they open, spending at most 15% of your cookies per step.',
	setWeeds: 'Uproot meddleweed the layout has no use for - but only once it has ripened, because the fungus spore it drops when pulled scales with its age.',
	setAsk:   'Ask before uprooting anything that would otherwise keep growing. Turn it off and the assistant clears straight through.'
};

function tip(key) {
	return HELP[key] ? ' title="' + HELP[key].replace(/"/g, '&quot;') + '"' : '';
}

function injectCSS() {
	if (document.getElementById('grandpasGreenhouseCSS')) return;
	var st = document.createElement('style');
	st.id = 'grandpasGreenhouseCSS';
	st.textContent = buildCSS();
	document.head.appendChild(st);
}

function settingsHTML() {
	var html = '<div class="ggRow">';
	for (var i = 0; i < SETTINGS_META.length; i++) {
		var meta = SETTINGS_META[i];
		html += '<div class="ggSet"' + tip(meta.help) + '><input type="checkbox" id="ggSet-' + meta.key +
			'" data-key="' + meta.key + '">' +
			'<label for="ggSet-' + meta.key + '">' + meta.label + '</label></div>';
	}
	html += '</div>' +
		'<div class="ggRow"><span class="ggNote" id="ggModeHint"></span></div>';
	return html;
}

function buildPanel(host) {
	injectCSS();
	var panel = document.createElement('div');
	panel.id = PANEL_ID;

	var modeBtns = '';
	for (var i = 0; i < MODES.length; i++) {
		modeBtns += '<div class="ggBtn" data-act="mode" data-mode="' + MODES[i].key + '" ' +
			'title="' + MODES[i].hint.replace(/"/g, '&quot;') + '" ' +
			'id="ggMode-' + MODES[i].key + '">' + MODES[i].label + '</div>';
	}

	// A rebuilt panel starts empty, so anything remembered about the old DOM
	// is stale - both caches must reset or setHTML skips the first write.
	htmlCache = {};
	seedGridKey = '';

	panel.innerHTML =
		'<div class="ggRow">' +
			'<span class="ggTitle">GRANDPA&#39;S GREENHOUSE' +
				'<span class="ggVer">v' + VERSION + '</span></span>' + modeBtns +
			'<div class="ggBtn" data-act="settings"' + tip('settings') + '>Settings</div>' +
			'<div class="ggBtn" data-act="replan"' + tip('replan') + '>Re-plan</div>' +
			'<span class="ggStat" id="ggProgress"' + tip('progress') + '></span>' +
		'</div>' +
		'<div id="ggChoiceRow" class="ggRow">' +
			'<span class="ggStat" id="ggChoiceLabel"></span>' +
			'<select id="ggChoice"></select>' +
			'<span class="ggStat" id="ggChoiceInfo"></span>' +
		'</div>' +
		'<div id="ggSeedRow" class="ggRow" style="display:none;">' +
			'<div class="ggSeedGrid" id="ggSeedGrid"></div>' +
		'</div>' +
		'<div class="ggRow"><span class="ggStat" id="ggRecipe"></span></div>' +
		'<div id="ggClearRow" class="ggRow ggAlert" style="display:none;"' + tip('clearRow') + '>' +
			'<span class="ggAlertText" id="ggClearText"></span>' +
			'<div class="ggBtn" data-act="clearYes"' + tip('clearYes') + '>Clear them</div>' +
			'<div class="ggBtn" data-act="clearNo"' + tip('clearNo') + '>Keep them</div>' +
		'</div>' +
		'<div id="ggSettingsBox" style="display:none;"><hr class="ggSep">' + settingsHTML() + '</div>' +
		'<hr class="ggSep">' +
		'<div class="ggRow" style="align-items:flex-start;gap:18px;">' +
			'<div' + tip('layout') + '><div class="ggStat" style="margin-bottom:3px;">Layout</div>' +
				'<div class="ggGrid" id="ggGrid"></div></div>' +
			'<div style="display:flex;flex-direction:column;gap:3px;" id="ggLegend"></div>' +
			'<div class="ggStat" id="ggStatus" style="flex:1;min-width:200px;"' + tip('step') + '></div>' +
		'</div>';

	host.parentNode.insertBefore(panel, host.nextSibling);
	panel.addEventListener('click', onPanelClick);
	panel.addEventListener('change', onPanelChange);
	return panel;
}

function ensurePanel() {
	if (typeof document === 'undefined') return null;
	var panel = document.getElementById(PANEL_ID);
	if (panel && panel.isConnected) return panel;
	var host = document.getElementById('gardenContent');
	if (!host) return null;
	if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
	panelJustBuilt = true;
	return buildPanel(host);
}

function onPanelClick(e) {
	var el = e.target.closest ? e.target.closest('[data-act]') : null;
	if (!el) return;
	var m = garden();
	var act = el.getAttribute('data-act');

	if (act === 'mode') {
		S.mode = el.getAttribute('data-mode');
		plan = null;
		if (m) { rebuildPlan(m, true); }
	} else if (act === 'clearYes') {
		decideClearance('clear');
		// Act now rather than at the next garden step - five minutes after
		// pressing a button is not an answer to the button.
		if (m) { try { runStep(m); } catch (err) { console.error('[Grandpa\'s Greenhouse] clear failed:', err); } }
	} else if (act === 'clearNo') {
		decideClearance('keep');
	} else if (act === 'pick') {
		// '*' is the Auto tile: hand the choice back to the assistant.
		var seed = el.getAttribute('data-seed');
		S.target = (seed === '*') ? '' : seed;
		seedGridKey = '';
		if (m) rebuildPlan(m, true);
	} else if (act === 'settings') {
		showSettings = !showSettings;
	} else if (act === 'replan') {
		if (m) rebuildPlan(m, true);
	}
	safeUI('panel refresh', refreshPanel);
}

function onPanelChange(e) {
	var el = e.target;
	var m = garden();
	if (el.id === 'ggChoice') {
		if (S.mode === 'boost') S.objective = el.value;
		else S.target = el.value;
		if (m) rebuildPlan(m, true);
	} else if (el.getAttribute && el.getAttribute('data-key')) {
		S[el.getAttribute('data-key')] = !!el.checked;
	}
	safeUI('panel refresh', refreshPanel);
}

function setText(id, text) {
	var el = document.getElementById(id);
	if (el && el.textContent !== text) el.textContent = text;
}

function setTitle(id, text) {
	var el = document.getElementById(id);
	if (el && el.getAttribute('title') !== text) el.setAttribute('title', text);
}

var htmlCache = {};

function setHTML(id, html) {
	// Comparing against el.innerHTML looks right and is not: the browser
	// re-serializes what it parsed (#4fa3d1 comes back as rgb(79,163,209)),
	// so the strings never match and the element rebuilds every frame. The
	// last string actually written is the only honest thing to compare with.
	if (htmlCache[id] === html) return;
	var el = document.getElementById(id);
	if (!el) return;
	el.innerHTML = html;
	htmlCache[id] = html;
}

/**
 * The seed picker, as a grid of the game's own seed packets rather than a
 * dropdown: 34 species is a lot to read as text, and the icons are the thing
 * players already recognise from the panel beside the plot.
 *
 * Sorted the way the assistant itself ranks them, so the leftmost tiles are
 * the ones it would pick on its own. Blocked seeds stay in the grid, greyed -
 * knowing a seed exists but is out of reach is half the information.
 */
function seedGridHTML(m) {
	var missing = lockedSeeds(m);
	if (!missing.length) return '<span class="ggStat">every seed is banked</span>';

	missing.sort(function (a, b) {
		var ra = bestRecipeFor(m, a), rb = bestRecipeFor(m, b);
		var sa = ra ? ra.chance * (1 + unblockCount(m, a)) : -1;
		var sb = rb ? rb.chance * (1 + unblockCount(m, b)) : -1;
		return sb - sa;
	});

	var chosen = (S.target && m.plants[S.target] && !m.plants[S.target].unlocked) ? S.target : '';
	var auto   = !chosen;
	var active = (plan && plan.target) || currentTarget(m);

	var html = '<div class="ggSeed ggAuto' + (auto ? ' ggSel' : '') + '" data-act="pick" ' +
		'data-seed="*" title="Let the assistant choose - it ranks by chance x how many ' +
		'further seeds the pick unblocks, and will clear the plot to farm meddleweed when ' +
		'that beats every route it can sow.">Auto</div>';

	for (var i = 0; i < missing.length; i++) {
		var key = missing[i], p = m.plants[key], rec = bestRecipeFor(m, key);
		var sel = chosen ? (key === chosen) : (key === active);
		var tip = p.name + ' - ' + (rec
			? fmtPct(rec.chance) + ' from ' + recipeText(m, rec)
			: 'no route you can sow yet');
		html += '<div class="ggSeed' + (sel ? ' ggSel' : '') + (rec ? '' : ' ggBlocked') +
			'" data-act="pick" data-seed="' + key + '" title="' + tip.replace(/"/g, '&quot;') + '">' +
			'<div class="ggSeedIcon" style="background-position:0px -' + (p.icon * 48) + 'px;"></div>' +
			'</div>';
	}
	return html;
}

function speciesColors(grid, tiles) {
	var order = [], map = {};
	for (var t = 0; t < tiles.length; t++) {
		var key = grid[tiles[t][1]][tiles[t][0]];
		if (key && !map[key]) { map[key] = PLAN_COLORS[order.length % PLAN_COLORS.length]; order.push(key); }
	}
	return {map:map, order:order};
}

function refreshPanel() {
	var m = garden();
	if (!m || !document.getElementById(PANEL_ID)) return;

	for (var i = 0; i < MODES.length; i++) {
		var btn = document.getElementById('ggMode-' + MODES[i].key);
		if (btn) btn.className = 'ggBtn' + (S.mode === MODES[i].key ? ' ggOn' : '');
	}

	var tiles = unlockedTiles(m);
	var have = unlockedCount(m), all = m.plantsN;
	var used = 0;
	for (var t = 0; t < tiles.length; t++) if (m.plot[tiles[t][1]][tiles[t][0]][0] > 0) used++;
	setText('ggProgress', 'Seeds ' + have + '/' + all + '  -  plot ' + used + '/' + tiles.length + ' used');

	var box = document.getElementById('ggSettingsBox');
	if (box) box.style.display = showSettings ? 'block' : 'none';
	if (showSettings) {
		for (var i = 0; i < SETTINGS_META.length; i++) {
			var input = document.getElementById('ggSet-' + SETTINGS_META[i].key);
			if (input) input.checked = !!S[SETTINGS_META[i].key];
		}
		setText('ggModeHint', modeByKey(S.mode).hint);
	}

	// --- the choice row: a seed in Breed, a bonus in Boost -------------
	var choiceRow = document.getElementById('ggChoiceRow');
	var seedRow   = document.getElementById('ggSeedRow');
	var sel       = document.getElementById('ggChoice');
	if (S.mode === 'breed' || S.mode === 'boost') {
		choiceRow.style.display = 'flex';
		if (S.mode === 'boost') {
			// The boost objectives are six phrases with no icon to show, so
			// they stay a dropdown; only the seeds became a grid.
			seedRow.style.display = 'none';
			if (sel) sel.style.display = '';
			setText('ggChoiceLabel', 'Boost:');
			setTitle('ggChoiceLabel', HELP.boost);
			setTitle('ggChoice', HELP.boost);
			var opts = '';
			for (var i = 0; i < OBJECTIVES.length; i++) {
				opts += '<option value="' + OBJECTIVES[i].key + '">' + OBJECTIVES[i].label + '</option>';
			}
			setHTML('ggChoice', opts);
			if (sel) sel.value = S.objective;
		} else {
			seedRow.style.display = 'flex';
			if (sel) sel.style.display = 'none';
			setText('ggChoiceLabel', 'Breed:');
			setTitle('ggChoiceLabel', HELP.breed);
			// Rebuilding this string every frame is wasted work, and setHTML
			// would not write it anyway; the key is what can change it.
			var gk = unlockedCount(m) + '|' + S.target + '|' + ((plan && plan.target) || '');
			if (gk !== seedGridKey) { seedGridKey = gk; setHTML('ggSeedGrid', seedGridHTML(m)); }
		}

		if (S.mode === 'boost') {
			setText('ggChoiceInfo', plan && typeof plan.pct === 'number'
				? (plan.pct >= 0 ? '+' : '') + (plan.pct * 100).toFixed(1) + '%' : '');
			setText('ggRecipe', 'Fills every unlocked tile with the mix that maximises this bonus, ' +
				'scored against the game\'s own effect calculation.');
		} else if (plan && plan.stuck) {
			setText('ggChoiceInfo', 'stuck');
			setText('ggRecipe', 'Immortal plants sit on or next to every tile, so meddleweed can ' +
				'never sprout, and nothing you can sow breeds a missing seed. Harvesting an ' +
				'immortal by hand frees a corner for the nursery.');
		} else if (plan && plan.nursery) {
			setText('ggChoiceInfo', 'nursery');
			setText('ggRecipe', 'Nothing you can sow breeds anything you are missing. The plot is ' +
				'being cleared on purpose: meddleweed only sprouts in a tile with no neighbours, ' +
				'and uprooting it once ripe drops the spore that opens the whole fungus branch.');
		} else {
			var t2 = (plan && plan.target) || currentTarget(m);
			var rec = t2 ? bestRecipeFor(m, t2) : null;
			setText('ggChoiceInfo', rec ? fmtPct(rec.chance) + ' per empty tile per step' : '');
			setText('ggRecipe', rec ? ('needs ' + recipeText(m, rec)) :
				(t2 ? 'no route you can sow yet - bank one of its parents first' : ''));
		}
	} else {
		choiceRow.style.display = 'none';
		seedRow.style.display = 'none';
		setText('ggRecipe', modeByKey(S.mode).hint);
	}

	// --- the clearance question -----------------------------------------
	var clearRow = document.getElementById('ggClearRow');
	var removals = removalsFor(m), clearance = clearanceState();
	if (clearRow) {
		if (clearance === 'ask' && removals.length) {
			var names = {}, order = [];
			for (var i = 0; i < removals.length; i++) {
				if (!names[removals[i].name]) { names[removals[i].name] = 0; order.push(removals[i].name); }
				names[removals[i].name]++;
			}
			var parts = [];
			for (var i = 0; i < order.length && i < 4; i++) parts.push(names[order[i]] + 'x ' + order[i]);
            if (order.length > 4) parts.push('and ' + (order.length - 4) + ' more');
			clearRow.style.display = 'flex';
			setText('ggClearText', removals.length + ' plant' + (removals.length === 1 ? '' : 's') +
				' stand in the way of this layout (' + parts.join(', ') + '). Uproot them?');
		} else {
			clearRow.style.display = 'none';
		}
	}

	// --- layout preview -------------------------------------------------
	var grid = plan && plan.grid;
	var html = '', legend = '';
	if (grid) {
		var cols = speciesColors(grid, tiles);
		for (var y = 0; y < 6; y++) {
			for (var x = 0; x < 6; x++) {
				if (!m.isTileUnlocked(x, y)) { html += '<div class="ggCell ggLocked"></div>'; continue; }
				var key = grid[y][x];
				if (!key) { html += '<div class="ggCell ggHole" title="left empty for mutations"></div>'; continue; }
				html += '<div class="ggCell" style="background:' + cols.map[key] +
					';border-color:' + cols.map[key] + ';" title="' + m.plants[key].name + '"></div>';
			}
		}
		for (var i = 0; i < cols.order.length; i++) {
			legend += '<div class="ggLegend"><span class="ggSwatch" style="background:' +
				cols.map[cols.order[i]] + ';"></span>' + m.plants[cols.order[i]].name + '</div>';
		}
		var holes = 0;
		for (var t = 0; t < tiles.length; t++) if (!grid[tiles[t][1]][tiles[t][0]]) holes++;
		if (S.mode === 'breed') {
			legend += '<div class="ggLegend"><span class="ggSwatch ggHole" style="background:rgba(255,255,255,0.03);' +
				'border-style:dashed;"></span>' + holes + ' empty, where it can mutate</div>';
		}
	} else {
		for (var y = 0; y < 6; y++) {
			for (var x = 0; x < 6; x++) {
				html += '<div class="ggCell' + (m.isTileUnlocked(x, y) ? '' : ' ggLocked') + '"></div>';
			}
		}
	}
	setHTML('ggGrid', html);
	setHTML('ggLegend', legend);

	// --- status ---------------------------------------------------------
	var lines = [];
	if (plan && S.mode === 'breed' && typeof plan.score === 'number') {
		lines.push('<span title="' + HELP.yield.replace(/"/g, '&quot;') + '">Expected ' +
			fmtRate(plan.score) + '</span>');
	}
	var secs = Math.max(0, Math.round((m.nextStep - Date.now()) / 1000));
	lines.push('Next step in ' + Math.floor(secs / 60) + 'm ' + (secs % 60) + 's  (' +
		m.soilsById[m.soil].name + ')');
	lines.push(statusText);
	if (clearance === 'keep' && removals.length) {
		lines.push(removals.length + ' plants kept in place - the layout fills in as they free up');
	}
	lines.push('Harvested ' + stats.harvested + '  -  new seeds banked ' + stats.banked +
		'  -  planted ' + stats.planted);
	setHTML('ggStatus', lines.join('<br>'));
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

function saveString() {
	return JSON.stringify({v:1, S:S, stats:stats});
}

function loadString(str) {
	if (!str) return;
	var data = JSON.parse(str);
	if (data.S) for (var k in DEFAULTS) if (typeof data.S[k] === typeof DEFAULTS[k]) S[k] = data.S[k];
	if (data.stats) for (var k in stats) if (typeof data.stats[k] === 'number') stats[k] = data.stats[k];
	plan = null;
}

/* ------------------------------------------------------------------ *
 * Hooks
 * ------------------------------------------------------------------ */

function safeUI(what, fn) {
	if (uiBroken) return;
	try {
		fn();
	} catch (err) {
		uiBroken = true;
		console.error('[Grandpa\'s Greenhouse] ' + what + ' failed - the panel is disabled for this ' +
			'session, the assistant itself keeps working. Please report this:', err);
	}
}

/**
 * Runs inside Game.Logic(), so the whole body is guarded: an error escaping
 * here would take the game's main loop with it.
 */
function onLogic() {
	var m = garden();
	if (!m) return;

	safeUI('panel setup', function () {
		ensurePanel();
		if (panelJustBuilt) { panelJustBuilt = false; refreshPanel(); }
	});

	try {
		ensureRecipes(m);
	} catch (err) {
		statusText = 'could not read the mutation table - see console';
		console.error('[Grandpa\'s Greenhouse] reading getMuts failed:', err);
		return;
	}

	// M.nextStep is the timestamp of the next garden step, so it changing is
	// the one reliable signal that a step just happened. It also moves when the
	// soil changes, which is exactly when a re-plan is wanted anyway.
	var stepped = (m.nextStep !== lastStep);
	if (!stepped) {
		// Nothing the panel shows changes faster than its countdown's whole
		// seconds, so thirty redraw attempts a second are wasted 36-tile
		// scans; four are indistinguishable from the player's side.
		var now = Date.now();
		if (now - lastPanelRefresh >= 250) {
			lastPanelRefresh = now;
			safeUI('panel refresh', refreshPanel);
		}
		return;
	}
	var first = (lastStep === -1);
	lastStep = m.nextStep;

	try {
		rebuildPlan(m, false);
		if (!first) runStep(m);
	} catch (err) {
		statusText = 'error - see console';
		console.error('[Grandpa\'s Greenhouse] step failed:', err);
	}

	lastPanelRefresh = Date.now();
	safeUI('panel refresh', refreshPanel);
}

function onReset() {
	// Ascending relocks every seed but the first, so both the plan and the
	// growable-recipe shortlist are stale. The measured table itself is not:
	// the mutation rules did not change.
	plan = null;
	lastStep = -1;
	statusText = 'reset - waiting for the garden';
}

Game.registerMod(MOD_ID, {
	init: function () {
		Game.registerHook('logic', onLogic);
		Game.registerHook('reset', onReset);
		console.log('[Grandpa\'s Greenhouse] v' + VERSION + ' ready.');
	},
	save: function () {
		try { return saveString(); } catch (e) { return ''; }
	},
	load: function (str) {
		try { loadString(str); } catch (e) { /* keep defaults */ }
	},

	/**
	 * A small read-only window on what the assistant worked out, for other
	 * mods and for dev/test.js. Nothing here mutates the garden; setMode and
	 * setTarget only move the same switches the panel does.
	 */
	version: VERSION,
	getRecipes:  function () { var m = garden(); return m ? ensureRecipes(m) : null; },
	getMatureOdds: function (key) { var m = garden(); return m ? matureOdds(m.plants[key]) : 0; },
	getLandChance: function (counts, key) {
		var m = garden(); return m ? expectedChance(m, fillCounts(m, counts), key) : 0;
	},
	getSnapshotChance: function (counts, key) {
		var m = garden(); return m ? snapshotChance(m, fillCounts(m, counts), key) : 0;
	},
	getRecipe:   function (key) { var m = garden(); return m ? bestRecipeFor(m, key) : null; },
	getPlan:     function () { return plan; },
	getSettings: function () { return S; },
	getStats:    function () { return stats; },
	getStatus:   function () { return statusText; },
	setMode:     function (mode) { S.mode = mode; plan = null; },
	setTarget:   function (key) { S.target = key || ''; plan = null; },
	setObjective:function (key) { S.objective = key; plan = null; },
	replan:      function () { var m = garden(); return m ? rebuildPlan(m, true) : null; },
	getRemovals: function () { var m = garden(); return m ? removalsFor(m) : []; },
	getClearance:function () { return clearanceState(); },
	decide:      function (what) { decideClearance(what); },
	runStepNow:  function () { var m = garden(); if (m) { rebuildPlan(m, false); runStep(m); } }
});

})();
