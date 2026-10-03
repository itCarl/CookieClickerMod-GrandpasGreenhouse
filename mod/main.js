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
var VERSION  = '1.4';
var PANEL_ID = 'grandpasGreenhousePanel';

/* ------------------------------------------------------------------ *
 * Modes and objectives
 * ------------------------------------------------------------------ */

var MODES = [
	{key:'off',   label:'Off',
		hint:'Nothing is touched - pick this to plant by hand. The panel still shows recipes and progress.'},
	{key:'tend',  label:'Tend',
		hint:'Harvests anything new so the seed is banked, clears plants about to expire, ' +
			 'uproots ripe meddleweed. Your layout is left alone.'},
	{key:'breed', label:'Breed',
		hint:'Works towards one seed. Lays out the plot for the best recipe and keeps it planted.'},
	{key:'boost', label:'Boost',
		hint:'Fills the plot with the layout that maximises the bonus you pick.'},
	{key:'plant', label:'Plant',
		hint:'Grows the layout you marked with Plant this in Layouts, exactly as drawn. Sows it, ' +
			 'replants what expires, leaves immortals be.'},
	{key:'unlocks', label:'Unlocks',
		hint:'Hunts the garden upgrades that plants drop. Fills the plot with the banked species whose ' +
			 'drop you are still missing, the most drops per step first, and harvests it as it matures - regardless ' +
			 'of the harvest-mature setting, because that harvest is when the drop rolls. Stops once ' +
			 'every drop is unlocked.'}
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

// Up to 1.3 a 'custom' mode planted a drawing of your own; a save still
// holding it loads as Off. Plant does that job now, from the library: the
// layout it grows is the one marked with Plant this, not a mode of its own.
function modeByKey(key) {
	for (var i = 0; i < MODES.length; i++) if (MODES[i].key === key) return MODES[i];
	return MODES[0];
}

function isMode(key) {
	for (var i = 0; i < MODES.length; i++) if (MODES[i].key === key) return true;
	return false;
}

/** The modes that keep a layout planted, as opposed to only tending what is there. */
function layoutMode() {
	return S.mode === 'breed' || S.mode === 'boost' || S.mode === 'plant' || S.mode === 'unlocks';
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
	clearImmediately: false,// clear unwanted banked growth as it sprouts, not once it matures
	pullWeeds:     true,    // uproot meddleweed the plan does not want
	askBeforeClearing: true,// ask before uprooting a plant the layout does not want
	expirySteps:   1,       // steps of the plant's own growth to leave before it withers
	ripenWeeds:    90,      // let meddleweed reach this age before uprooting it
	maxSpendPct:   0.15,    // most of your cookies the assistant may spend in one step
	plantLayout:   '',      // the library layout Plant mode grows, by name; '' for none
	tab:           'assistant' // which view the panel shows: 'assistant' | 'layouts' | 'settings'
	// No 'layout' any more: it named the drawing Custom mode planted. Saves
	// up to 1.3 still carry it; the loader only reads keys listed here, so it
	// is ignored, and the next save leaves it out.
};

// Each toggle names the group the Settings page files it under - what part
// of the assistant's work it governs - so the page reads as four short
// questions rather than one list. Groups appear in the order first named here.
var SETTINGS_META = [
	{key:'bankNew',       label:'Harvest new species on sight (this is what banks a seed)',
		help:'setBank', group:'Harvesting'},
	{key:'harvestMature', label:'Harvest mature plants before they expire', help:'setMature',
		group:'Harvesting'},
	{key:'keepPlan',      label:'Keep the layout planted', help:'setPlan', group:'Planting'},
	{key:'clearImmediately', label:'Clear unwanted growth immediately', help:'setClearNow',
		group:'Planting'},
	{key:'pullWeeds',     label:'Uproot ripe meddleweed the layout does not want', help:'setWeeds',
		group:'Weeds'},
	{key:'askBeforeClearing', label:'Ask before uprooting plants that stand in the way of the layout',
		help:'setAsk', group:'Safety'}
];

var S = {};
(function () { for (var k in DEFAULTS) S[k] = DEFAULTS[k]; })();
// The drawn layouts, [{name, grid, recipe?, use?}] - recipe being the breed
// plan key a layout was made for, and use whether it stands in for the
// assistant's own layout on that plan. Kept out of DEFAULTS on purpose: the
// loader copies any default whose type matches, and an array would pass that
// test with whatever a save put in it. These are checked shape by shape.
S.layouts = [];

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

var recipes    = null;  // targetKey -> [{target, chance, parents:[{key,n}], ceilings:{}}]
var recipesFor = null;  // built once, from the game's own getMuts
var drops      = null;  // plantKey -> [{upgrade, chance}], read once from the plants' onHarvest
var plan       = null;  // {grid:[[key|'']], score, label, key}
var lastStep   = -1;
// The soil the plan was last made on, or null before the first look. Soil
// changes how fast plants grow and so what a layout is worth, but it is kept
// out of every plan key on purpose: a layout linked to a recipe must survive
// the player swapping soil. So a change is watched for here instead.
var lastSoil   = null;
var lastPanelRefresh = 0;   // when the per-frame panel refresh last ran
var statusText = 'waiting for the garden';
var STUCK_MSG  = 'stuck - immortal plants block the weed nursery and nothing you can sow leads anywhere new';
var NO_PLANT_MSG = 'no layout active - pick one in Layouts';
var ALL_DROPS_MSG = 'all garden upgrades unlocked';
var stats      = {harvested:0, planted:0, banked:0, uprooted:0};
var seedGridKey = '';   // what the seed picker was last drawn for
// planKey -> 'clear' | 'keep'. Deliberately keyed by plan and deliberately not
// saved: a decision covers the layout you were shown and nothing else, so
// changing mode, target or plot size asks again, and so does reloading.
var clearDecision = {};
// The Layouts tab's own state, none of it saved: which layout is open in the
// editor, the seed a click paints (null until one is picked), the question
// or text box open in the tab, and the last thing an import said.
var libSel = '';
// The seed whose library default is open in the editor instead of a stored
// layout ('' for none). A default has no name of its own to select it by
// that would survive a rename of the seed's stored twin, so it goes by seed.
var libVirt = '';
// planKey -> grid: the library defaults worked out so far. Not saved - a
// default is recomputed, never stored - and dropped whole when the plot
// changes size, since every key it holds is then stale.
var virtGrids = {};
var virtTiles = -1;
var brush  = null;
var dialog = null;
var showWipeConfirm = false;   // the Reset-mod-data question on the Settings page
var libNote = '';
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

/**
 * The recipe to lay out when a player asks for a seed's breeding layout,
 * whether or not the seed is missing. For a missing seed this is exactly
 * bestRecipeFor - a route naming the target itself can never be sown while
 * the target is locked - so the key matches the one the assistant builds when
 * it gets there. A banked seed also breeds from itself (thumbcorn off two
 * thumbcorn), which is no layout for breeding it; those routes are skipped.
 * With no route sowable yet, the best one is laid out anyway, the way a
 * drawn layout waits for seeds the collection has not reached.
 */
function breedRecipeFor(m, targetKey) {
	var list = ensureRecipes(m)[targetKey] || [], fallback = null;
	for (var i = 0; i < list.length; i++) {
		var self = false;
		for (var j = 0; j < list[i].parents.length; j++) if (list[i].parents[j].key === targetKey) self = true;
		if (self) continue;
		if (recipeGrowable(m, list[i])) return list[i];
		if (!fallback) fallback = list[i];
	}
	return fallback || list[0] || null;
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
		key:   breedPlanKey(m, rec.target, rec),
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
 * Upgrade drops, read out of the game
 * ------------------------------------------------------------------ */

/**
 * A few plants drop a garden upgrade when harvested mature. Nothing on the
 * plant object says which: the drop is one line inside its onHarvest, a call
 * to M.dropUpgrade(name, chance). So, as with getMuts, the game is asked
 * rather than transcribed - each plant's own onHarvest is called once, as if
 * harvested at maturity, with M.dropUpgrade swapped for a recorder. If Orteil
 * adds a drop or retunes one, this follows without an edit.
 *
 * Called for real, a harvest hook pays out: a bakeberry earns cookies, a
 * juicy queenbeet finds a sugar lump. So for the length of the probe every
 * function on Game and on the garden is swapped for one that does nothing,
 * and every one is put back in the finally, whatever the hooks did. They run
 * synchronously, so nothing else in the game can see the swap. A hook that
 * throws on the stubs has still recorded any drop it reached before it threw.
 */
function buildDrops(m) {
	var found = {}, current = null, swapped = [];
	function noop() {}
	function stubAll(obj) {
		for (var k in obj) {
			if (!Object.prototype.hasOwnProperty.call(obj, k) || typeof obj[k] !== 'function') continue;
			var real = obj[k];
			try { obj[k] = noop; swapped.push([obj, k, real]); } catch (err) { /* read-only: leave it */ }
		}
	}
	try {
		stubAll(Game);
		stubAll(m);
		m.dropUpgrade = function (upgrade, chance) {
			if (!current || typeof upgrade !== 'string' || !(chance > 0)) return;
			(found[current] || (found[current] = [])).push({upgrade: upgrade, chance: chance});
		};
		for (var key in m.plants) {
			var p = m.plants[key];
			if (typeof p.onHarvest !== 'function') continue;
			current = key;
			try { p.onHarvest(0, 0, matureAge(p)); } catch (err) { /* see above */ }
		}
	} finally {
		current = null;
		for (var i = swapped.length - 1; i >= 0; i--) swapped[i][0][swapped[i][1]] = swapped[i][2];
	}
	return found;
}

function ensureDrops(m) {
	if (drops) return drops;
	drops = buildDrops(m);
	return drops;
}

/**
 * Whether an upgrade no longer needs hunting: bought, or dropped into the
 * store and waiting to be bought. The game's own dropUpgrade only checks
 * Game.Has, so a harvest would keep rolling for one already in the store -
 * but rolling again cannot help, buying it is the player's step.
 */
function upgradeFound(name) {
	if (typeof Game.Has === 'function' && Game.Has(name)) return true;
	return typeof Game.HasUnlocked === 'function' && !!Game.HasUnlocked(name);
}

/**
 * Every species with a drop still missing, ranked, split by whether its seed
 * is banked: {open: [...], locked: [...]}, each entry {key, name, upgrades,
 * chance, steps, rate}. Two drops on one plant would be two rolls, so its
 * chance is the odds of either.
 *
 * The ranking is expected drops per garden step on a tile: the chance a
 * mature harvest rolls, divided by the steps it takes to mature. Raw chance
 * alone is the wrong unit, for the same reason age is (see "Growth, measured
 * in steps"): elderwort rolls 1% but needs some 160 steps to get there, green
 * rot rolls 0.5% every three or four, and so finds its upgrade about twenty
 * times sooner. At an equal rate the higher raw chance wins. The whole plot
 * goes to the top species. Each drop is an independent roll with no memory,
 * so splitting the plot between hunts does not finish the set any sooner -
 * it only delays the first one.
 */
function huntList(m) {
	var d = ensureDrops(m), open = [], locked = [];
	for (var key in d) {
		var p = m.plants[key];
		if (!p || !p.plantable) continue;
		var missing = [], none = 1;
		for (var i = 0; i < d[key].length; i++) {
			if (upgradeFound(d[key][i].upgrade)) continue;
			missing.push(d[key][i].upgrade);
			none *= 1 - d[key][i].chance;
		}
		if (!missing.length) continue;
		var steps = Math.max(1, matureAge(p) / ageStep(p));
		var entry = {key: key, name: p.name, upgrades: missing, chance: 1 - none,
			steps: steps, rate: (1 - none) / steps};
		(p.unlocked ? open : locked).push(entry);
	}
	var rank = function (a, b) { return (b.rate - a.rate) || (b.chance - a.chance); };
	open.sort(rank);
	locked.sort(rank);
	return {open: open, locked: locked};
}

/** The species Unlocks mode harvests the moment they mature, as a set; null in any other mode. */
function huntSet(m) {
	if (S.mode !== 'unlocks') return null;
	var h = huntList(m), out = {};
	for (var i = 0; i < h.open.length; i++) out[h.open[i].key] = true;
	return out;
}

function upgradeCount(list) {
	var n = 0;
	for (var i = 0; i < list.length; i++) n += list[i].upgrades.length;
	return n;
}

/** What Unlocks mode says when there is nothing it can plant. */
function huntIdleText(h) {
	if (!h.locked.length) return ALL_DROPS_MSG;
	var first = h.locked[0], more = upgradeCount(h.locked) - first.upgrades.length;
	return 'breed ' + first.name + ' first to hunt ' + (first.upgrades.length === 1 ? 'its upgrade' : 'its upgrades') +
		(more ? ' - ' + more + ' more wait on seeds you have not unlocked' : '');
}

/* ------------------------------------------------------------------ *
 * Keeping the plan current
 * ------------------------------------------------------------------ */

function currentTarget(m) {
	if (S.target && m.plants[S.target] && !m.plants[S.target].unlocked) return S.target;
	return suggestTarget(m);
}

/**
 * The plan key of breeding `target` with `rec` on this plot. Written once,
 * here, because a library layout is linked to a breed plan by this string
 * alone: a layout picked by seed in the Layouts tab has to carry exactly the
 * key the assistant builds when it later breeds that seed itself.
 */
function breedPlanKey(m, target, rec) {
	return 'breed:' + target + ':' + parentsKey(rec.parents) + ':' + unlockedTiles(m).length;
}

function wantedPlanKey(m) {
	if (S.mode === 'breed') {
		var d = decideBreed(m);
		if (d.done) return 'breed:done';
		// Capacity is part of the key so a hand-harvested immortal, or anything
		// else that frees a corner, triggers a re-plan on the next step.
		if (d.stuck) return 'breed:stuck:' + unlockedTiles(m).length + ':' + nurseryCapacity(m);
		if (d.nursery || !d.recipe) return 'breed:nursery';
		return breedPlanKey(m, d.target, d.recipe);
	}
	if (S.mode === 'boost') return 'boost:' + S.objective + ':' + unlockedTiles(m).length;
	if (S.mode === 'plant') return plantPlanKey(m);
	if (S.mode === 'unlocks') return unlocksPlanKey(m);
	return 'none';
}

/**
 * Unlocks mode's key names the species it can hunt and every upgrade still
 * missing, so buying one - or banking a seed that drops one - re-plans on the
 * next look. Nothing about luck is in it: a drop that has not come yet is
 * simply the same plan, kept planted until the game grants it.
 */
function unlocksPlanKey(m) {
	var h = huntList(m), open = [], missing = [];
	for (var i = 0; i < h.open.length; i++) {
		open.push(h.open[i].key);
		missing = missing.concat(h.open[i].upgrades);
	}
	for (var i = 0; i < h.locked.length; i++) missing = missing.concat(h.locked[i].upgrades);
	if (!missing.length) return 'unlocks:done';
	return 'unlocks:' + unlockedTiles(m).length + ':' + open.join(',') + ':' + missing.sort().join('|');
}

/**
 * Plant mode's key is the drawing itself, tile by tile, and the plot size.
 * So a stroke in the editor, a Set to default or marking another layout
 * re-plans on the next look, and the clearance question is asked again for
 * the new drawing - while a rename, which changes nothing on the plot, does
 * neither. Whether a seed is unlocked yet stays out: runStep asks that live.
 */
function plantPlanKey(m) {
	var lay = layoutByName(S.plantLayout);
	if (!lay) return 'plant:none';
	var rows = [];
	for (var y = 0; y < 6; y++) rows.push(lay.grid[y].join(','));
	return 'plant:' + unlockedTiles(m).length + ':' + rows.join('/');
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
		// A layout the player customized for exactly this plan replaces the
		// computed one outright. That is the only way a breed layout changes
		// by hand: the preview in the assistant's view is a picture, so there
		// is one place to shape a layout and one answer to which tiles it plants.
		var over = overrideFor(want);
		if (over) applyOverride(m, plan, over);
	} else if (S.mode === 'boost') {
		plan = planBoost(m, S.objective);
		if (plan) plan.key = want;
	} else if (S.mode === 'plant') {
		// The drawing, verbatim - no climb, no score, no recipe. A layout in
		// use for breeding is grown as drawn too; the link is Breed's business.
		var lay = layoutByName(S.plantLayout);
		if (!lay) {
			plan = null;
			statusText = NO_PLANT_MSG;
			return null;
		}
		plan = {grid: sowableCopy(m, lay.grid), score: 0, key: want, label: lay.name, layout: lay.name};
	} else if (S.mode === 'unlocks') {
		// The top species on every tile (see huntList for why not a mix).
		// With nothing banked left to hunt there is no grid at all, so the
		// plot is left alone - an empty grid would ask to clear it.
		var h = huntList(m);
		if (!h.open.length) {
			plan = {grid: null, score: 0, key: want, label: 'Unlocks', idle: huntIdleText(h), locked: h.locked};
			statusText = plan.idle;
			return plan;
		}
		var top = h.open[0], g = emptyGrid(), tiles = unlockedTiles(m);
		for (var t = 0; t < tiles.length; t++) g[tiles[t][1]][tiles[t][0]] = top.key;
		plan = {grid: g, score: top.chance, key: want, label: top.name, hunt: top, locked: h.locked,
			left: upgradeCount(h.open) + upgradeCount(h.locked)};
	} else {
		plan = null;
	}
	return plan;
}

/* ------------------------------------------------------------------ *
 * The breed layout on screen
 *
 * The climb finds a good layout, not the only one, and a player may know
 * something it does not. A breed layout is reshaped in the Layouts tab,
 * as a library layout linked to its recipe, and scored by the same function
 * as the computed one, so the number shown is the game's own verdict on the
 * layout actually being planted. Nothing downstream needs to know: runStep
 * and removalsFor only ever read plan.grid.
 * ------------------------------------------------------------------ */

/** The current plan, if it is a real breed layout - not a nursery, not stuck. */
function breedLayoutPlan() {
	if (S.mode !== 'breed' || !plan || !plan.grid || plan.nursery || plan.stuck || !plan.recipe) return null;
	return plan;
}

function rescorePlan(m, p) {
	p.score = scoreBreedPlan(m, p.grid, unlockedTiles(m), p.target);
}

/* ------------------------------------------------------------------ *
 * Layouts drawn from scratch
 *
 * A customized breed layout reshapes one the assistant chose. A layout can
 * also be drawn on a blank plot with any seed the game lets you sow and kept
 * by name - a shape copied from a guide, a mix to try later. A library
 * layout reaches the plot in one of two ways: Use for breeding on a layout
 * linked to a recipe, or Plant this, which marks the one layout Plant mode
 * grows as drawn - an immortal golden clover field, say. The mark is a
 * name in S.plantLayout, so it is saved with the mode and follows a rename.
 * ------------------------------------------------------------------ */

// Settings is a view like Layouts: opening it leaves the mode alone, and it
// is remembered in S.tab the same way, so a reload reopens it.
var TABS = ['assistant', 'layouts', 'settings'];
var NAME_MAX = 40;

function setTab(tab) {
	if (TABS.indexOf(tab) >= 0) S.tab = tab;
}

function layoutIndex(name) {
	for (var i = 0; i < S.layouts.length; i++) if (S.layouts[i].name === name) return i;
	return -1;
}

function layoutByName(name) {
	var i = layoutIndex(name);
	return i >= 0 ? S.layouts[i] : null;
}

/**
 * The stored layout open in the editor: the one last picked, else the first.
 * None while a library default is open - that one is editorDefault's.
 */
function editorLayout() {
	var lay = layoutByName(libSel);
	if (lay) return lay;
	if (libVirt) return null;
	return S.layouts[0] || null;
}

/** Opens a stored layout in the editor. */
function pickStored(name) {
	libSel = name;
	libVirt = '';
}

/** A name is a label on a button, not a place to paste a paragraph. */
function cleanName(name) {
	return (typeof name === 'string' ? name : '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

/**
 * The name itself if no other layout has it, else the name with a number
 * counted up behind it. `except` is a layout being renamed, which may keep
 * its own name.
 */
function uniqueName(base, except) {
	var name = base, n = 1;
	for (;;) {
		var i = layoutIndex(name);
		if (i < 0 || S.layouts[i] === except) return name;
		name = base + ' ' + (++n);
	}
}

function defaultLayoutName() {
	return uniqueName('Layout ' + (S.layouts.length + 1));
}

/**
 * What a layout tile may hold: nothing, or a seed the game lets you sow.
 * Juicy queenbeet is in M.plants too, but nothing ever sows it - it only grows
 * out of eight queenbeets - so a layout naming it could never be planted.
 * Whether the seed is unlocked yet is deliberately not asked: a layout drawn
 * ahead of the collection just waits for it.
 */
function sowable(m, key) {
	if (key === '') return true;
	if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(m.plants, key)) return false;
	return !!m.plants[key].plantable;
}

/** Six rows of six strings - the one grid shape everything here uses. */
function gridShaped(g) {
	if (!Array.isArray(g) || g.length !== 6) return false;
	for (var y = 0; y < 6; y++) {
		if (!Array.isArray(g[y]) || g[y].length !== 6) return false;
		for (var x = 0; x < 6; x++) if (typeof g[y][x] !== 'string') return false;
	}
	return true;
}

/**
 * A copy of a drawn grid with anything the game would not sow blanked out - a
 * save can carry a key from a patch that renamed a plant, and the panel reads
 * every planned key as a real species.
 */
function sowableCopy(m, src) {
	var grid = emptyGrid();
	for (var y = 0; y < 6; y++) {
		for (var x = 0; x < 6; x++) if (sowable(m, src[y][x])) grid[y][x] = src[y][x];
	}
	return grid;
}

function createLayout(name) {
	name = uniqueName(cleanName(name) || defaultLayoutName());
	S.layouts.push({name: name, grid: emptyGrid()});
	pickStored(name);
	return name;
}

/**
 * A layout in use for a breed plan is planted under the plan's own key, not
 * its name, so a rename only has to follow it onto the live plan's label.
 */
function renameLayout(m, from, to) {
	var lay = layoutByName(from);
	if (!lay) return null;
	var name = uniqueName(cleanName(to) || lay.name, lay);
	lay.name = name;
	if (libSel === from) libSel = name;
	if (plan && plan.override === from) plan.override = name;
	if (S.plantLayout === from) S.plantLayout = name;
	if (plan && plan.layout === from) plan.layout = plan.label = name;
	return name;
}

/**
 * The copy keeps the recipe it was made for but is never in use, even when
 * the original is: one recipe is planted from one layout, and a duplicate is
 * made to try a variation, not to take over.
 */
function duplicateLayout(name) {
	var i = layoutIndex(name);
	if (i < 0) return null;
	var copy = {name: uniqueName(S.layouts[i].name), grid: cloneGrid(S.layouts[i].grid)};
	if (typeof S.layouts[i].recipe === 'string') copy.recipe = S.layouts[i].recipe;
	S.layouts.splice(i + 1, 0, copy);
	pickStored(copy.name);
	return copy.name;
}

/**
 * Deleting a layout that stands in for a breed plan needs no fallback: the
 * assistant's own layout is right there, and the rebuild plants it. Deleting
 * the one Plant mode grows leaves it nothing to grow until another is marked.
 */
function deleteLayout(m, name) {
	var i = layoutIndex(name);
	if (i < 0) return false;
	S.layouts.splice(i, 1);
	if (S.plantLayout === name) S.plantLayout = '';
	if (plan && (plan.override === name || plan.layout === name)) { plan = null; if (m) rebuildPlan(m, true); }
	if (libSel === name) libSel = (S.layouts[i] || S.layouts[i - 1] || {name: ''}).name;
	return true;
}

/**
 * Opens a layout in the editor by name: a stored one, or else a library
 * default of that name. Opening a default is only looking - it is worked out
 * for the editor and stored by nothing but a change to it.
 */
function selectLayout(m, name) {
	if (layoutByName(name)) { pickStored(name); return true; }
	if (!m) return false;
	var defs = breedDefaults(m);
	for (var i = 0; i < defs.length; i++) if (defs[i].name === name) return selectDefault(m, defs[i].seed);
	return false;
}

function setBrush(key) {
	brush = (typeof key === 'string') ? key : null;
}

/** The seed a click paints; until one is picked, the first you have unlocked. */
function currentBrush(m) {
	if (brush !== null) return brush;
	for (var i = 0; i < m.plantsById.length; i++) {
		var p = m.plantsById[i];
		if (p.plantable && p.unlocked) return p.key;
	}
	return '';
}

/**
 * One click in the editor. It writes straight into the stored layout - there
 * is no save button to forget - and, if that layout is in use for the breed
 * plan, into the live plan too, so the next step already plants the new drawing.
 * A plot tile the farm has not unlocked is not part of the garden and takes
 * no paint.
 *
 * With a library default open, the first stroke is what makes it the
 * player's: it is stored first, then painted. A refused stroke stores
 * nothing, since it changed nothing.
 */
function paintTile(m, x, y, key) {
	if (!(x >= 0 && x < 6 && y >= 0 && y < 6)) return false;
	if (!m.isTileUnlocked(x, y) || !sowable(m, key)) return false;
	var lay = editorLayout() || materializeDefault(m, libVirt);
	if (!lay) return false;
	lay.grid[y][x] = key;
	// Rescored as well, so the yield line answers the click at once.
	if (plan && plan.override === lay.name && breedLayoutPlan() === plan) {
		plan.grid[y][x] = key;
		rescorePlan(m, plan);
	}
	// The layout Plant mode grows is keyed by its drawing, so the stroke has
	// already moved the key; re-planning now puts it in the preview at once.
	if (S.mode === 'plant' && S.plantLayout === lay.name) rebuildPlan(m, false);
	return true;
}

/** A layout as it leaves the mod: a fresh copy, with the link only if it has one. */
function layoutOut(l) {
	var out = {name: l.name, grid: cloneGrid(l.grid)};
	if (typeof l.recipe === 'string') out.recipe = l.recipe;
	if (l.use === true && typeof l.recipe === 'string') out.use = true;
	return out;
}

function exportLayouts() {
	var out = [];
	for (var i = 0; i < S.layouts.length; i++) out.push(layoutOut(S.layouts[i]));
	return JSON.stringify(out);
}

/**
 * Pasted text, merged into the library. Everything is checked before anything
 * is added, so a bad paste leaves the library exactly as it was rather than
 * half-imported - one wrong key in the tenth layout rejects all ten, with a
 * message that says which and where.
 */
function importLayouts(m, text) {
	function fail(msg) { return {ok: false, added: 0, msg: msg}; }
	if (!m) return fail('The garden is not loaded yet.');
	var data;
	try { data = JSON.parse(String(text)); } catch (err) { return fail('That is not valid JSON.'); }

	var list = Array.isArray(data) ? data : [data];
	if (!list.length) return fail('There are no layouts in that text.');
	var clean = [];
	for (var i = 0; i < list.length; i++) {
		var it = list[i], where = list.length > 1 ? 'Layout ' + (i + 1) + ': ' : '';
		if (!it || typeof it !== 'object' || Array.isArray(it)) {
			return fail(where + 'expected an object with a name and a grid.');
		}
		if (it.name !== undefined && typeof it.name !== 'string') return fail(where + 'the name must be text.');
		if (it.recipe !== undefined && typeof it.recipe !== 'string') {
			return fail(where + 'the recipe must be text - the breed plan the layout stands in for.');
		}
		if (it.use !== undefined && typeof it.use !== 'boolean') {
			return fail(where + 'use must be true or false - whether the layout is used for breeding.');
		}
		if (!gridShaped(it.grid)) {
			return fail(where + 'the grid must be 6 rows of 6 seed keys, with "" for an empty tile.');
		}
		for (var y = 0; y < 6; y++) {
			for (var x = 0; x < 6; x++) {
				if (!sowable(m, it.grid[y][x])) {
					return fail(where + '"' + it.grid[y][x] + '" in row ' + (y + 1) + ', column ' + (x + 1) +
						' is not a seed you can sow.');
				}
			}
		}
		clean.push({name: cleanName(it.name) || 'Imported layout', grid: cloneGrid(it.grid), recipe: it.recipe,
			use: it.use});
	}

	// An imported layout in use is a use chosen now, so it takes the recipe
	// over from whichever layout had it - the same rule as Use for breeding.
	// Without the flag it only says what it was made for, and changes nothing.
	var linked = false;
	for (var i = 0; i < clean.length; i++) {
		var lay = {name: uniqueName(clean[i].name), grid: clean[i].grid};
		S.layouts.push(lay);
		if (typeof clean[i].recipe !== 'string') continue;
		linkRecipe(lay, clean[i].recipe);
		if (clean[i].use === true) { claimRecipe(lay); linked = true; }
	}
	if (linked) relinked(m);
	return {ok: true, added: clean.length,
		msg: 'Imported ' + clean.length + ' layout' + (clean.length === 1 ? '' : 's') + '.'};
}

/* ------------------------------------------------------------------ *
 * Breed layouts customized per recipe
 *
 * A player who prefers another shape for a recipe wants something that
 * lasts: copy the assistant's layout into the library once, reshape it there,
 * and have the assistant plant that drawing every time it breeds with this
 * recipe again. This is the only way to change a breed layout by hand.
 *
 * The link is the plan key itself - target, parents and plot size - so a
 * plot that grows, or a better recipe coming into reach, gives a different
 * key and the computed layout quietly returns. The drawing is not pruned:
 * it is a layout in its own right, and the player's work.
 *
 * Which recipe a layout belongs to and whether it is planted are two things.
 * A seed's breeding layout can be opened from the Layouts tab just to look at
 * or reshape it, and taking over the live plan is not something a click on a
 * seed should do behind the player's back. So the key is a label, and a
 * separate flag - Use for breeding - is what hands the layout to the plan.
 * ------------------------------------------------------------------ */

/**
 * The library layout standing in for this plan key, if one is in use for it.
 * Being made for the recipe is not enough: a library default the player
 * painted or renamed is there to look at and reshape, and the assistant keeps planting its own
 * until the player says Use for breeding.
 */
function overrideFor(key) {
	for (var i = 0; i < S.layouts.length; i++) {
		if (S.layouts[i].recipe === key && S.layouts[i].use === true) return S.layouts[i];
	}
	return null;
}

/** Any library layout made for this plan key - the one in use first. */
function layoutForRecipe(key) {
	var over = overrideFor(key);
	if (over) return over;
	for (var i = 0; i < S.layouts.length; i++) if (S.layouts[i].recipe === key) return S.layouts[i];
	return null;
}

/**
 * Plants the linked layout in place of the computed one. The computed grid
 * and score are kept beside it, so the panel can say what the drawing is
 * worth against the assistant's own layout. Keys the game would not sow are
 * blanked.
 */
function applyOverride(m, p, lay) {
	if (!p.origGrid) { p.origGrid = cloneGrid(p.grid); p.origScore = p.score; }
	p.grid = sowableCopy(m, lay.grid);
	p.override = lay.name;
	rescorePlan(m, p);
}

/**
 * Marks which breed plan a layout was made for. Only a label on its own -
 * several layouts may carry the same recipe, as variations to choose from.
 */
function linkRecipe(lay, key) {
	lay.recipe = key;
	if (lay.use) claimRecipe(lay);
}

/** One recipe is planted from one layout: putting this one in use stops whoever had it. */
function claimRecipe(lay) {
	for (var i = 0; i < S.layouts.length; i++) {
		if (S.layouts[i] !== lay && S.layouts[i].recipe === lay.recipe) delete S.layouts[i].use;
	}
	lay.use = true;
}

/**
 * A link changed, so the breed plan on screen may now have a different grid.
 * Its key has not moved, so only a forced rebuild would notice.
 */
function relinked(m) {
	if (m && S.mode === 'breed') rebuildPlan(m, true);
}

/**
 * Copies the assistant's layout for the current breed plan into the library,
 * linked to that plan. The copy is always the computed grid - origGrid when a
 * linked layout already stands in for it - because this one is a fresh start
 * the player will reshape in the editor anyway.
 */
function customizeCurrentPlan(m) {
	var p = breedLayoutPlan();
	if (!p) return null;
	var name = uniqueName(cleanName(p.label) || defaultLayoutName());
	var lay = {name: name, grid: cloneGrid(p.origGrid || p.grid)};
	S.layouts.push(lay);
	linkRecipe(lay, p.key);
	// Customize is pressed on the plan being bred, so it is the player asking
	// for their version of that plan - in use from the start.
	claimRecipe(lay);
	pickStored(name);
	// No re-plan needed: the drawing is the computed grid, so it only has to
	// be put in place, and a rebuild would rerun the whole climb for nothing.
	if (m) applyOverride(m, p, lay);
	return name;
}

/** Puts a layout made for a recipe in use: the assistant plants it for that plan from now on. */
function useForBreeding(m, name) {
	var lay = layoutByName(name);
	if (!lay || typeof lay.recipe !== 'string') return false;
	claimRecipe(lay);
	relinked(m);
	return true;
}

/**
 * Takes a layout out of use; the assistant's layout returns. The recipe stays
 * on it, so the badge still says what it was made for and Use for breeding
 * can put it back.
 */
function stopUsing(m, name) {
	var lay = layoutByName(name);
	if (!lay || !lay.use) return false;
	delete lay.use;
	if (plan && plan.override === name) { plan = null; relinked(m); }
	return true;
}

/**
 * Plant this: marks the one layout Plant mode grows, taking the mark from
 * whichever had it. The mode is left alone, as Use for breeding leaves it -
 * the Plant tab is where planting starts. A default is stored first, like
 * every other change to one, so the mark names a layout that lasts.
 */
function plantThis(m, name) {
	var lay = layoutByName(name);
	if (!lay && m) {
		var defs = breedDefaults(m);
		for (var i = 0; i < defs.length && !lay; i++) {
			if (defs[i].name === name) lay = materializeDefault(m, defs[i].seed);
		}
	}
	if (!lay) return false;
	S.plantLayout = lay.name;
	if (m && S.mode === 'plant') rebuildPlan(m, false);
	return true;
}

/** Stop planting: Plant mode has nothing to grow until another layout is marked. */
function stopPlanting(m, name) {
	if (!S.plantLayout || S.plantLayout !== name) return false;
	S.plantLayout = '';
	if (m && S.mode === 'plant') rebuildPlan(m, false);
	return true;
}

/**
 * Opens a seed's breeding layout in the editor as a stored layout. A layout
 * already made for the plan is reopened; otherwise the assistant's own
 * layout for it - the same recipe, the same climb, the same key it would use
 * itself - is stored, so the player starts from the computed shape instead
 * of a blank plot. This is how a library default becomes the player's own.
 * Nothing the assistant plants changes: that is Use for breeding.
 */
function loadBreedLayout(m, targetKey) {
	if (!m || typeof targetKey !== 'string' || !Object.prototype.hasOwnProperty.call(m.plants, targetKey)) return null;
	var rec = breedRecipeFor(m, targetKey);
	if (!rec) return null;
	var key = breedPlanKey(m, targetKey, rec);
	var have = layoutForRecipe(key);
	if (have) { pickStored(have.name); return have.name; }
	var name = uniqueName(cleanName('Breeding ' + m.plants[targetKey].name) || defaultLayoutName());
	var lay = {name: name, grid: cloneGrid(defaultGrid(m, key, rec))};
	S.layouts.push(lay);
	linkRecipe(lay, key);
	pickStored(lay.name);
	return lay.name;
}

/* ------------------------------------------------------------------ *
 * Library defaults
 *
 * The library lists a breeding layout for every seed with a recipe without
 * the player storing any. Those defaults are worked out, not kept: a default
 * is the assistant's layout for the plot as it is now, and a stored copy
 * would go stale the moment the plot grew or a better recipe came in reach.
 * So nothing about them reaches the save or the export, and the player's own
 * layouts are never rewritten by one - a stored layout for the same plan, or
 * of the same name, simply takes the default's place in the list.
 *
 * Working out a default is a full climb, so it happens only when one is
 * opened, and the grid is kept per plan key for as long as the key holds.
 * The list itself needs only names and keys, which are cheap.
 * ------------------------------------------------------------------ */

/**
 * A seed's default: its name, the plan key it stands for and the recipe,
 * plus the stored layout that takes its place (twin), if there is one.
 */
function breedDefault(m, seed) {
	if (typeof seed !== 'string' || !Object.prototype.hasOwnProperty.call(m.plants, seed)) return null;
	var rec = breedRecipeFor(m, seed);
	if (!rec) return null;
	var e = {seed: seed, name: cleanName('Breeding ' + m.plants[seed].name), recipe: breedPlanKey(m, seed, rec),
		rec: rec, twin: null};
	for (var i = 0; i < S.layouts.length && !e.twin; i++) {
		if (S.layouts[i].recipe === e.recipe || S.layouts[i].name === e.name) e.twin = S.layouts[i];
	}
	return e;
}

/** The defaults the library lists, in the game's order: every seed with a recipe and no stored twin. */
function breedDefaults(m) {
	var out = [];
	for (var i = 0; i < m.plantsById.length; i++) {
		var e = breedDefault(m, m.plantsById[i].key);
		if (e && !e.twin) out.push(e);
	}
	return out;
}

/** The computed grid for a plan key - climbed once, then reused until the plot changes. */
function defaultGrid(m, key, rec) {
	var n = unlockedTiles(m).length;
	if (n !== virtTiles) { virtGrids = {}; virtTiles = n; }
	if (!virtGrids[key]) virtGrids[key] = planBreed(m, rec).grid;
	return virtGrids[key];
}

function selectDefault(m, seed) {
	var e = m ? breedDefault(m, seed) : null;
	if (!e || e.twin) return false;
	libSel = '';
	libVirt = seed;
	return true;
}

/**
 * The default open in the editor, if one is. Should it have gained a stored
 * twin meanwhile (an import, say), the editor moves on to the twin, which is
 * what the list now shows in its place.
 */
function editorDefault(m) {
	if (!libVirt || !m || layoutByName(libSel)) return null;
	var e = breedDefault(m, libVirt);
	if (!e) { libVirt = ''; return null; }
	if (e.twin) { pickStored(e.twin.name); return null; }
	return e;
}

/**
 * Turns a default into a stored layout, for a change the player makes to it:
 * the computed grid, made for the plan, not in use. Returns the stored layout.
 */
function materializeDefault(m, seed) {
	if (!m || !seed) return null;
	var name = loadBreedLayout(m, seed);
	return name ? layoutByName(name) : null;
}

/**
 * The recipe a stored layout's plan key names, looked up in today's table:
 * the same target and parents. Null when the key names no recipe the mod
 * knows - a patch renamed a plant, or the key was typed by hand.
 */
function recipeOfKey(m, key) {
	var parts = String(key).split(':');
	if (parts[0] !== 'breed' || !m || !Object.prototype.hasOwnProperty.call(m.plants, parts[1])) return null;
	var parents = parts.slice(2, parts.length - 1).join(':');
	var list = ensureRecipes(m)[parts[1]] || [];
	for (var i = 0; i < list.length; i++) if (parentsKey(list[i].parents) === parents) return list[i];
	return null;
}

/**
 * Set to default: the one way a stored layout's drawing is replaced by the
 * assistant's, and only ever on the player's word (it asks first, in the
 * panel). The grid is worked out for the layout's own recipe on the plot as
 * it is now; name, recipe link and in-use flag stay exactly as they were.
 */
function resetToDefault(m, name) {
	var lay = layoutByName(name);
	if (!m || !lay || typeof lay.recipe !== 'string') return false;
	var rec = recipeOfKey(m, lay.recipe);
	if (!rec) return false;
	lay.grid = cloneGrid(defaultGrid(m, breedPlanKey(m, rec.target, rec), rec));
	// The drawing on the plot is this one, so the live plan must follow.
	if (plan && (plan.override === lay.name || plan.layout === lay.name)) {
		plan = null;
		rebuildPlan(m, true);
	}
	return true;
}

/** What a linked layout's badge says: the target seed, or the raw key if it names none. */
function recipeBadge(m, key) {
	var parts = String(key).split(':');
	var p = (parts[0] === 'breed' && m && Object.prototype.hasOwnProperty.call(m.plants, parts[1]))
		? m.plants[parts[1]] : null;
	return p ? p.name : String(key);
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
 * Never listed: weeds (worthless, and governed by their own setting),
 * immortals (never uprooted at all), species not yet banked (left to ripen -
 * that also covers the breed target, which is unbanked by definition), and
 * the layout's own plants on their own tiles.
 *
 * A plant that has not matured is listed only on the nursery plot, or when
 * clearImmediately is on: by default it is left to grow until it matures, and
 * with the setting it is taken as soon as it sprouts, before a spreading
 * fungus can seed its neighbours.
 *
 * A mature plant already within the expiry margin is left to harvestMature,
 * which takes it this step without asking - it was going to die this cycle
 * anyway. With that setting off nothing else would take it, so it is listed
 * like any other.
 *
 * In Unlocks mode a mature plant of a hunted species is never listed either:
 * runStep harvests it without asking, because that harvest rolls its drop.
 */
function removalsFor(m) {
	var out = [];
	if (!layoutMode()) return out;
	if (!plan || !plan.grid || !S.keepPlan) return out;

	var grid = plan.grid, nursery = !!plan.nursery, tiles = unlockedTiles(m), hunting = huntSet(m);
	for (var t = 0; t < tiles.length; t++) {
		var x = tiles[t][0], y = tiles[t][1], tile = m.plot[y][x];
		var p = plantOf(m, tile);
		if (!p || p.immortal || p.weed || !p.unlocked) continue;
		if (grid[y][x] === p.key) continue;

		var age = tile[1], mature = age >= p.mature;
		if (!mature && !nursery && !S.clearImmediately) continue;
		if (mature && age >= harvestAgeOf(p) && S.harvestMature) continue;
		if (mature && hunting && hunting[p.key]) continue;
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

	var grid = layoutMode() ? (plan && plan.grid) : null;
	var nursery = !!(plan && plan.nursery);
	var tiles = unlockedTiles(m);
	var hunting = huntSet(m);
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

		// Unlocks mode exists for this harvest: a drop only rolls when a
		// mature plant is harvested, so a hunted species is taken the step it
		// matures, whatever harvestMature says - and its tile is sown again
		// below, in the same step.
		if (hunting && mature && hunting[p.key]) { harvestAt(m, x, y); continue; }

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
		else if (S.mode === 'plant' && !grid) statusText = NO_PLANT_MSG;
		else if (S.mode === 'unlocks' && !grid) statusText = (plan && plan.idle) || ALL_DROPS_MSG;
		else statusText = (S.mode === 'tend') ? 'tending' : 'no layout - nothing planted';
		return;
	}

	var budget = Game.cookies * S.maxSpendPct, spent = 0, planted = 0, short = 0, locked = 0;
	for (t = 0; t < tiles.length; t++) {
		x = tiles[t][0]; y = tiles[t][1];
		if (m.plot[y][x][0] > 0) continue;
		var key = grid[y][x];
		if (!key) continue;
		var want = m.plants[key];
		// A drawn layout may name a seed ahead of the collection; its tile
		// waits, and the status says so, until the seed is banked.
		if (want && want.plantable && !want.unlocked) { locked++; continue; }
		if (!want || !want.unlocked || !want.plantable) continue;
		var cost = plantAt(m, want, x, y, budget - spent);
		if (cost > 0 || m.getCost(want) === 0) { spent += cost; planted++; }
		else short++;
	}
	statusText = planted ? ('planted ' + planted + (spent ? ' for ' + fmtCookies(spent) + ' cookies' : ''))
		: (short ? 'waiting for cookies to fill ' + short + ' tiles' : 'layout is planted');
	if (locked) {
		statusText += ' - ' + locked + (locked === 1 ? ' tile waits for a seed' : ' tiles wait for seeds') +
			' you have not unlocked';
	}
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
	// The bar is a quiet surface: a deep warm brown-grey, a shade lighter at
	// the top, with the game's soft shaded edges over it so it still sits in
	// the game's frame language. No pattern of its own - the wooden tabs and
	// the framed panes carry the texture, and a pattern behind them only
	// fought the grain. CSS-drawn, so nothing can 404; the flat black comes
	// first as the usual fallback.
	'#' + PANEL_ID + '{position:relative;z-index:120;margin:0;padding:8px 24px 10px 24px;',
	'background:rgba(0,0,0,0.82);',
	'background-color:#17130f;',
	// The garden minigame's own soil tile, lightly washed so text stays
	// readable - the bar reads as the plot's dirt continuing downwards.
	// The wash darkens a touch towards the bottom, with a faint green cast at
	// the top so the dirt picks up the garden's accent instead of going flat.
	'background-image:linear-gradient(rgba(12,18,6,0.32),rgba(0,0,0,0.46)),',
	'url(' + gameImgURL('shadedBordersSoft.png') + '),url(' + gameImgURL('BGgarden.jpg') + ');',
	'background-size:auto,100% 100%,auto;color:#e8e8e8;font-size:14px;',
	'border-top:1px solid #79c600;box-shadow:0 0 8px rgba(0,0,0,0.6) inset;text-align:left;}',
	'#' + PANEL_ID + ' .ggRow{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:4px 0;}',
	'#' + PANEL_ID + ' .ggTitle{font-weight:bold;color:#94cd50;letter-spacing:1px;}',
	'#' + PANEL_ID + ' .ggVer{font-weight:normal;font-size:10px;letter-spacing:0;opacity:0.55;margin-left:5px;}',
	// Every button starts as the game's own a.option - the small button of its
	// prompts, the Options menu and the mod-data list - with the values copied
	// from style.css, so the panel's inline actions look like the game's.
	// The one departure is the horizontal margin: .ggRow already spaces its
	// children with a gap, and the option's 4px on top of it would double up.
	// The two images come after a plain black, so a renamed asset leaves the
	// bevelled black button the game itself shows while its images load.
	'#' + PANEL_ID + ' .ggBtn{display:inline-block;cursor:pointer;margin:2px 0;padding:4px 8px;',
	'font-size:12px;font-weight:normal;line-height:100%;color:#ccc;text-shadow:0 1px 1px #000;',
	'border:1px solid #e2dd48;border-color:#ece2b6 #875526 #733726 #dfbc9a;border-radius:2px;',
	'background-color:#000;',
	'background-image:url(' + gameImgURL('shadedBordersSoft.png') + '),url(' + gameImgURL('darkNoise.jpg') + ');',
	'background-size:100% 100%,auto;',
	'box-shadow:0 0 1px 2px rgba(0,0,0,0.5),0 2px 4px rgba(0,0,0,0.25),0 0 2px 2px #000 inset,',
	'0 1px 0 1px rgba(255,255,255,0.5) inset;}',
	// Hover and press as a.option:hover / :active. Longhands only: a
	// background shorthand here would also wipe the images of every variant
	// below, which is how the tabs used to lose their plank on hover.
	'#' + PANEL_ID + ' .ggBtn:hover{border-color:#fff;color:#fff;text-shadow:none;}',
	'#' + PANEL_ID + ' .ggBtn:active{background-color:#333;}',
	// A chosen inline option (the layout open in the editor, the active one)
	// takes the game's a.option.neato colours, its mark for a positive option.
	'#' + PANEL_ID + ' .ggBtn.ggOn{color:#096;border-color:#096;}',
	'#' + PANEL_ID + ' .ggBtn.ggOn:hover{color:#3c9;border-color:#3c9;}',
	'#' + PANEL_ID + ' .ggStat{font-size:13px;color:#bbb;}',
	'#' + PANEL_ID + ' .ggStat b{color:#fff;}',
	'#' + PANEL_ID + ' .ggGood{color:#9ed36a;}',
	'#' + PANEL_ID + ' .ggWarn{color:#ffd75e;}',
	'#' + PANEL_ID + ' .ggNote{font-size:12px;color:#9a9a9a;max-width:640px;line-height:1.4;}',
	'#' + PANEL_ID + ' select{background:#1a1a1a;color:#eee;border:1px solid #666;border-radius:3px;',
	'padding:1px 4px;font-size:13px;max-width:260px;}',
	'#' + PANEL_ID + ' label{font-size:13px;color:#ddd;cursor:pointer;}',
	'#' + PANEL_ID + ' .ggSet{display:flex;align-items:center;gap:5px;}',
	// No help cursor: hover text is the game's own tooltip now (see
	// onPanelOver), so the pointer only changes over things that take a click.
	// The plan preview: one small square per tile, laid out as the plot is.
	'#' + PANEL_ID + ' .ggGrid{display:grid;grid-template-columns:repeat(6,14px);grid-gap:2px;}',
	'#' + PANEL_ID + ' .ggCell{width:14px;height:14px;border-radius:2px;background:rgba(255,255,255,0.05);',
	'border:1px solid rgba(255,255,255,0.12);}',
	'#' + PANEL_ID + ' .ggCell.ggLocked{background:transparent;border-color:transparent;}',
	'#' + PANEL_ID + ' .ggCell.ggHole{background:rgba(255,255,255,0.03);border-style:dashed;}',
	// Only the Layouts editor's tiles take clicks; the assistant's preview is a picture.
	'#' + PANEL_ID + ' .ggCell.ggEdit{cursor:pointer;}',
	'#' + PANEL_ID + ' .ggCell.ggEdit:hover{box-shadow:0 0 0 1px #fff;}',
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
	// A packet that does nothing when clicked (a seed with no recipe in the
	// breeding row) is only there to be hovered, so it keeps the plain cursor.
	'#' + PANEL_ID + ' .ggSeed:not([data-act]){cursor:default;}',
	// Column 0 of gardenPlants.png is the seed packet; the row is plant.icon.
	// Scaled from the sheet's 48px cell to the 30px tile.
	'#' + PANEL_ID + ' .ggSeedIcon{position:absolute;left:0;top:0;width:48px;height:48px;',
	'pointer-events:none;transform:scale(0.625);transform-origin:0 0;',
	'background:url(' + spriteURL() + ');}',
	'#' + PANEL_ID + ' .ggAuto{width:auto;min-width:34px;padding:0 5px;display:flex;',
	'align-items:center;justify-content:center;font-size:11px;font-weight:bold;color:#ddd;}',

	// The one question the assistant ever asks, so it is allowed to be loud.
	// The Layouts dialog wears the same box. Above the panes it keeps the
	// panel's one 6px spacing unit; inside a pane the pane's gap spaces it.
	'#' + PANEL_ID + ' .ggAlert{background:rgba(210,140,40,0.16);border:1px solid #c8912e;',
	'border-radius:4px;padding:5px 9px;margin:6px 0 0 0;}',
	'#' + PANEL_ID + ' .ggPane .ggAlert{margin:0;}',
	'#' + PANEL_ID + ' .ggAlertText{color:#ffd75e;font-size:13px;}',

	// One tab bar: the six modes, then Layouts and Settings. A mode tab is both "show the
	// assistant" and "work this way", so a separate Assistant tab above them
	// only added a click.
	// No gap between the modes: the strip is one connected bar of planks, the
	// way the game's Options / Stats / Info / Legacy row is one panel with
	// notches between its cells rather than four floating buttons.
	'#' + PANEL_ID + ' .ggTabs{display:flex;align-items:flex-end;gap:0;margin-right:6px;}',
	// Dressed in the game's own wood: the plank sprite behind the Options /
	// Stats / Info / Legacy buttons, framed with the frameBorder.png edge that
	// the game's .framed boxes use. The .framed class itself is not applied,
	// because its dark-noise background, padding, margin and line-height would
	// all have to be overridden again - only its border-image is wanted.
	// Every image comes after a plain colour and border, so if a patch renames
	// an asset the tab falls back to the flat look it had before.
	// The crop is taken from the sheet's right-hand cell, clear of the notch
	// the game cuts for its centre divider, and the fixed width keeps the tab
	// inside that clean 97px strip.
	// Every property the .ggBtn option look sets is restated here, so nothing
	// of the black button shows through the plank.
	// Tabs after the first pull 1px left, so their 1px fallback borders
	// overlap into one shared line, and position:relative lets the open tab
	// stack above its neighbours to show its own edges.
	// Sized for eight in a row: narrow planks and the smaller type, with the
	// crop 2px down the plank to keep the grain centred on the short tab.
	// Eight 64px planks make a strip of about 512px, which the title row
	// holds beside the title; the row wraps rather than overflows, so on a
	// narrow window the seed count drops to a line of its own.
	'#' + PANEL_ID + ' .ggBtn.ggTab{box-sizing:border-box;width:64px;text-align:center;margin:0 0 0 -1px;',
	'position:relative;padding:3px 0 2px 0;font-size:12px;line-height:100%;',
	'font-weight:normal;color:#d8d2c6;border-radius:0;',
	'background-color:transparent;border:1px solid rgba(255,255,255,0.35);border-bottom-width:0;',
	'background-image:url(' + gameImgURL('panelMenu3.png') + ');background-repeat:no-repeat;',
	'background-size:auto;background-position:-103px -16px;',
	// The frame is drawn 3px wide over a 1px border, so the layout and the
	// fallback border stay exactly what they were without the image. Only
	// the top and right edges by default: the right edge of one tab is the
	// divider before the next, and a left edge too would draw every divider
	// twice as thick as the strip's outer frame.
	'border-image:url(' + gameImgURL('frameBorder.png') + ') 3 / 3px 3px 0 0 round;',
	// Colour and shadows are .panelButton's own.
	'text-shadow:0 1px 0 #444,0 0 4px #000;',
	'box-shadow:0 0 6px 1px rgba(0,0,0,0.6) inset,0 -1px 3px rgba(0,0,0,0.5);}',
	// Only the strip's outer corners are rounded and only the first tab
	// closes the strip on the left, so the row reads as one bar.
	'#' + PANEL_ID + ' .ggBtn.ggTab:first-child{margin-left:0;border-top-left-radius:3px;',
	'border-image-width:3px 3px 0 3px;}',
	'#' + PANEL_ID + ' .ggBtn.ggTab:last-child{border-top-right-radius:3px;}',
	// Hover is .panelButton:hover, which the game shares with .selected: the
	// sheet's lit row and white text (#statsButton / #logButton do exactly
	// this). The overlay colour only shows if the sheet is missing.
	'#' + PANEL_ID + ' .ggBtn.ggTab:hover{background-color:rgba(255,255,255,0.2);color:#fff;',
	'background-position:-103px -112px;text-shadow:0 1px 0 #999,0 0 4px #000;}',
	'#' + PANEL_ID + ' .ggBtn.ggTab:active{background-color:rgba(255,255,255,0.2);}',
	// The open tab has the same lit row, and since hovering already lights a
	// plank it also stands a little taller and carries the store's warm inner
	// glow, so it still reads as the raised one while another is hovered.
	// Lifted above the bar, the open tab needs its own left edge as well, or
	// the part standing clear of its neighbour would be unframed; it stacks
	// above the neighbours so its green fallback border wins the shared line.
	'#' + PANEL_ID + ' .ggBtn.ggTab.ggOn{background-color:rgba(148,205,80,0.25);border-color:#94cd50;',
	'background-position:-103px -112px;color:#fff;font-weight:bold;z-index:1;',
	'border-image-width:3px 3px 0 3px;',
	'padding-top:4px;text-shadow:0 1px 0 #999,0 0 4px #000;',
	'box-shadow:0 0 10px rgba(255,238,221,0.55) inset,0 -2px 4px rgba(0,0,0,0.6);}',
	// ...and the tab before it hands over its right edge, so that divider is
	// still one frame thick. Separate rules on purpose: an engine without
	// :has() drops only these, and the divider beside the open tab is merely
	// a little heavier. The first-child variant restates the strip's left
	// edge, which the plain :has rule would otherwise strip at equal weight.
	'#' + PANEL_ID + ' .ggBtn.ggTab:has(+ .ggOn){border-image-width:3px 0 0 0;}',
	'#' + PANEL_ID + ' .ggBtn.ggTab:first-child:has(+ .ggOn){border-image-width:3px 0 0 3px;}',
	// Layouts and Settings stand a few pixels apart at the end of the bar: the
	// six modes change what the assistant does, these two only what the panel
	// shows. So the gap closes the mode run with its own corner and edge
	// (Unlocks, the last mode) and opens Layouts with one, as if each were a
	// strip's end.
	// Plain classes rather than :has(), so the gap looks right everywhere.
	// Unlocks keeps its right edge even while Layouts is lit - there is no
	// shared divider across the gap to hand over - hence the :not(.ggOn)
	// rule after the :has ones, and .ggOn's own full frame when Unlocks is lit.
	'#' + PANEL_ID + ' .ggBtn.ggTab.ggTabEnd{border-top-right-radius:3px;}',
	'#' + PANEL_ID + ' .ggBtn.ggTab.ggTabEnd:not(.ggOn){border-image-width:3px 3px 0 0;}',
	'#' + PANEL_ID + ' .ggBtn.ggTab.ggTabApart{margin-left:6px;border-top-left-radius:3px;',
	'border-image-width:3px 3px 0 3px;}',
	// Settings joins Layouts in that set-apart strip. When it is lit, Layouts
	// hands over its right edge like any tab before an open one, but keeps the
	// left edge that opens the strip - which the plain :has rule, being no
	// more specific than .ggTabApart, would not decide on its own.
	'#' + PANEL_ID + ' .ggBtn.ggTab.ggTabApart:has(+ .ggOn){border-image-width:3px 0 0 3px;}',
	// While Layouts or Settings is open, the mode the assistant is working in keeps a
	// small pip under its label - the dim .prefButton dot, not the lit plank,
	// so only one tab reads as open.
	'#' + PANEL_ID + ' .ggBtn.ggTab.ggCur{color:#ccc;}',
	'#' + PANEL_ID + ' .ggBtn.ggTab.ggCur:after{content:"";pointer-events:none;position:absolute;left:50%;',
	'bottom:1px;margin-left:-2px;width:4px;height:2px;border-radius:2px;background:#94cd50;',
	'box-shadow:0 0 3px rgba(148,205,80,0.8);}',
	// The editor: the preview's cells at seed-packet size, so the game's own
	// icons fit in them.
	'#' + PANEL_ID + ' .ggGrid.ggBig{grid-template-columns:repeat(6,32px);grid-gap:3px;}',
	'#' + PANEL_ID + ' .ggBig .ggCell{position:relative;width:30px;height:30px;overflow:hidden;}',
	// The game's own compact option size (.tight .option).
	'#' + PANEL_ID + ' .ggSmall{font-size:11px;padding:3px 6px;}',
	'#' + PANEL_ID + ' .ggDialog{flex-direction:column;align-items:flex-start;gap:5px;}',
	'#' + PANEL_ID + ' input[type=text],#' + PANEL_ID + ' textarea{background:#1a1a1a;color:#eee;',
	'border:1px solid #666;border-radius:3px;padding:2px 4px;font-size:13px;}',
	'#' + PANEL_ID + ' textarea{width:560px;max-width:100%;height:70px;font-family:monospace;font-size:11px;}',

	// The Layouts tab is split the way the game's own Manage mods prompt is:
	// a list on the left, what can be done with the selected entry on the
	// right. Stretch makes the library as tall as the editor, so the two
	// frames end on one line.
	'#' + PANEL_ID + ' .ggSplit{display:flex;align-items:stretch;gap:10px;margin:6px 0 0 0;}',
	// Each half is a .framed box: frameBorder.png over the dark noise, drawn
	// the same way as Settings (3px frame painted over a 1px bevel border) so
	// a renamed asset leaves a plain bordered box.
	'#' + PANEL_ID + ' .ggPane{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;',
	'padding:6px 10px 8px 10px;border:1px solid #875526;border-radius:2px;background-color:rgba(0,0,0,0.45);',
	'background-image:url(' + gameImgURL('darkNoise.jpg') + ');',
	'border-image:url(' + gameImgURL('frameBorder.png') + ') 3 / 3px round;',
	'box-shadow:0 0 1px 2px rgba(0,0,0,0.5),0 0 6px 1px rgba(0,0,0,0.5) inset;}',
	'#' + PANEL_ID + ' .ggLibPane{flex:0 0 250px;min-width:0;}',
	'#' + PANEL_ID + ' .ggEdPane{flex:1 1 auto;min-width:0;}',
	// The assistant's view is one pane across the full width, like Settings,
	// with the same margin the split gives the Layouts tab so both views start
	// on one line. Inside it the question side takes what is left over,
	// because the seed picker is the one thing in the view that uses width
	// well, and the plot side is fixed at what its preview, legend and status
	// lines need, so it does not jump as the legend changes length. The
	// question side stretches its rows (a plain .ggCol hugs its content) so
	// the picker and the clearance box run to the plot side's edge.
	'#' + PANEL_ID + ' .ggAsstPane{margin:6px 0 0 0;}',
	'#' + PANEL_ID + ' .ggPlanCol{flex:1 1 auto;align-items:stretch;}',
	'#' + PANEL_ID + ' .ggPlotCol{flex:0 0 340px;}',
	// Settings is a view of its own, one pane across the full width like the
	// assistant's. Its groups sit in two columns: five toggles with a line of
	// explanation each are too tall for the bar stacked, and a third column
	// would squeeze the explanations into slivers. Rows of the grid stretch,
	// so the two groups side by side end on one line.
	'#' + PANEL_ID + ' .ggSetPane{margin:6px 0 0 0;}',
	'#' + PANEL_ID + ' .ggSetGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;}',
	'#' + PANEL_ID + ' .ggSetGroup{display:flex;flex-direction:column;gap:4px;min-width:0;}',
	// A group's title is a smaller .ggHead: the same small caps and hairline,
	// one step down so the page's own heading still reads as the top.
	'#' + PANEL_ID + ' .ggSubHead{font-family:Merriweather,Georgia,serif;font-variant:small-caps;',
	'font-size:13px;color:#e8e0d0;text-shadow:0 1px 4px #000;border-bottom:1px solid rgba(255,255,255,0.12);',
	'padding:0 0 2px 0;margin:0 0 2px 0;}',
	'#' + PANEL_ID + ' .ggSetItem{position:relative;display:flex;flex-direction:column;gap:1px;}',
	// On/off as a small slide switch drawn in CSS, so nothing can 404. The
	// checkbox is still there for the state, the change event and the
	// keyboard, only moved out of sight (not display:none, which would take
	// it out of the tab order); its label is the switch. The track wears the
	// option button's bevel colours on a dark ground, the knob is a muted grey
	// when off and lights the title's green when on.
	'#' + PANEL_ID + ' .ggSwIn{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none;}',
	'#' + PANEL_ID + ' .ggSwitch{position:relative;flex:0 0 auto;box-sizing:border-box;width:26px;height:14px;',
	'border-radius:7px;cursor:pointer;background:#0d0b09;border:1px solid;',
	'border-color:#733726 #dfbc9a #ece2b6 #875526;',
	'box-shadow:0 1px 2px rgba(0,0,0,0.6) inset;transition:background-color 120ms,border-color 120ms;}',
	'#' + PANEL_ID + ' .ggSwitch:after{content:"";position:absolute;left:1px;top:1px;width:10px;height:10px;',
	'border-radius:50%;background:#77716a;box-shadow:0 1px 1px rgba(0,0,0,0.6);',
	'transition:left 120ms,background-color 120ms,box-shadow 120ms;}',
	'#' + PANEL_ID + ' .ggSwIn:checked + .ggSwitch{background:rgba(121,198,0,0.22);}',
	'#' + PANEL_ID + ' .ggSwIn:checked + .ggSwitch:after{left:13px;background:#9be03a;',
	'box-shadow:0 0 4px 1px rgba(121,198,0,0.8);}',
	'#' + PANEL_ID + ' .ggSet:hover .ggSwitch,#' + PANEL_ID + ' .ggSwIn:focus-visible + .ggSwitch{',
	'border-color:#fff;}',
	'#' + PANEL_ID + ' .ggSwIn:focus-visible + .ggSwitch{box-shadow:0 0 0 2px rgba(148,205,80,0.6);}',
	// The explanation sits under the label, indented past the switch (26px
	// and .ggSet's 5px gap) so it lines up with the label's first letter.
	'#' + PANEL_ID + ' .ggSetHelp{font-size:12px;line-height:1.35;color:#8f877a;padding-left:31px;}',
	'#' + PANEL_ID + ' .ggSetItem label{font-size:14px;}',
	// The one destructive button on the page wears the warning colour, so it
	// cannot be mistaken for a toggle's neighbour.
	'#' + PANEL_ID + ' .ggBtn.ggDanger{border-color:#c76a5a #7a2e1f #63241a #b05543;color:#f0b6a8;}',
	'#' + PANEL_ID + ' .ggBtn.ggDanger:hover{color:#fff;background-color:rgba(190,60,40,0.35);}',
	'#' + PANEL_ID + ' #ggStatus{line-height:1.4;}',
	// Rows inside a pane are spaced by the pane's own gap, not their margins.
	'#' + PANEL_ID + ' .ggPane .ggRow{margin:0;gap:6px;}',
	'#' + PANEL_ID + ' .ggCol{display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:0;}',
	'#' + PANEL_ID + ' .ggGrow{flex:1 1 auto;}',
	// The section heading is the game's .subsection title shrunk to fit a
	// bottom bar: Merriweather small caps, the dark wash fading right and
	// the hairline under it.
	'#' + PANEL_ID + ' .ggHead{font-family:Merriweather,Georgia,serif;font-variant:small-caps;',
	'font-size:15px;color:#fff;text-shadow:0 1px 4px #000;padding:1px 0 0 8px;',
	'background:linear-gradient(to right,rgba(0,0,0,0.5),rgba(0,0,0,0));}',
	'#' + PANEL_ID + ' .ggHead:after{content:"";display:block;height:1px;width:60%;margin:4px 0 0 -8px;',
	'background:linear-gradient(to right,rgba(255,255,255,0.25),rgba(255,255,255,0));}',
	// The library list scrolls rather than grows, like the game's .inner
	// lists. Absolutely placed inside a flexible box, so its content never
	// makes the pane taller than the editor beside it.
	'#' + PANEL_ID + ' .ggListBox{position:relative;flex:1 1 auto;min-height:96px;}',
	'#' + PANEL_ID + ' .ggList{position:absolute;left:0;top:0;right:0;bottom:0;overflow-x:hidden;',
	'overflow-y:auto;font-size:12px;background:rgba(0,0,0,0.3);',
	'box-shadow:0 0 0 1px rgba(255,255,255,0.2),0 2px 4px 2px rgba(0,0,0,0.5);}',
	// One row per layout, as .zebra .mouseOver rows with .selected for the
	// one open in the editor.
	'#' + PANEL_ID + ' .ggLibRow{display:flex;align-items:center;gap:6px;padding:4px 6px;}',
	'#' + PANEL_ID + ' .ggLibRow:nth-child(even){background:rgba(255,255,255,0.05);}',
	'#' + PANEL_ID + ' .ggLibRow[data-act]:hover{background:rgba(255,255,255,0.07);text-shadow:0 -1px 6px #fff;}',
	'#' + PANEL_ID + ' .ggLibRow.ggSel{background:rgba(255,255,255,0.1);',
	'box-shadow:0 0 0 1px rgba(255,255,255,0.5) inset;}',
	'#' + PANEL_ID + ' .ggLibRow{cursor:pointer;}',
	'#' + PANEL_ID + ' .ggLibRow.ggEmpty{cursor:default;color:#9a9a9a;}',
	// A default is the assistant's, not the player's, so its name is not set
	// in the bold the player's own layouts wear.
	'#' + PANEL_ID + ' .ggLibRow.ggVirt .ggLibName{font-weight:normal;color:#aaa;font-style:italic;}',
	// Names and badges shorten rather than wrap, so every row stays one line.
	'#' + PANEL_ID + ' .ggLibName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;',
	'white-space:nowrap;font-weight:bold;color:#ddd;}',
	'#' + PANEL_ID + ' .ggLibRow .ggStat{flex:0 1 auto;min-width:0;max-width:45%;overflow:hidden;',
	'text-overflow:ellipsis;white-space:nowrap;font-size:11px;}',
	// The game's small .tag chip, for the one layout being planted.
	'#' + PANEL_ID + ' .ggTag{flex:0 0 auto;font-size:10px;padding:0 4px;border-radius:3px;',
	'color:#fff;background:rgba(0,153,102,0.6);box-shadow:0 0 0 1px rgba(51,204,153,0.6) inset;}',
	// A grid with a column beside it - the editor's brush and colour key, the
	// preview's legend - in both views, and in the assistant's view the
	// question side beside the plot side as well.
	'#' + PANEL_ID + ' .ggPane .ggBody{align-items:flex-start;flex-wrap:nowrap;gap:12px;}',
	'#' + PANEL_ID + ' .ggPane .ggSeedGrid{max-width:none;}',
	'#' + PANEL_ID + ' #ggEditLegend,#' + PANEL_ID + ' #ggLegend{gap:3px;}',
	// An empty note would still take a gap in the pane's column.
	'#' + PANEL_ID + ' #ggLibNote:empty,#' + PANEL_ID + ' #ggEditLegend:empty,',
	'#' + PANEL_ID + ' #ggLegend:empty,#' + PANEL_ID + ' #ggRecipe:empty{display:none;}'
].join('');
}

/** The game's plant sprite sheet, cache-busted the way the game does it. */
function spriteURL() {
	return gameImgURL('gardenPlants.png');
}

/**
 * Any image from the game's own img folder, through Game.resPath and the
 * version cache-buster, so the mod follows the game wherever it is served
 * from and picks up a patched asset instead of a stale cached one.
 */
function gameImgURL(file) {
	var base = (typeof Game !== 'undefined' && Game.resPath) ? Game.resPath : '';
	var ver  = (typeof Game !== 'undefined' && Game.version) ? Game.version : '';
	return base + 'img/' + file + '?v=' + ver;
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
	wipe:     'Puts every setting back to its default and deletes your drawn layouts and the counters. The garden itself is not touched. Use it when the mod misbehaves and you want a clean start.',
	plan:     'What the assistant is working towards in this mode, anything it needs you to decide, and the layout it wants in the ground.',
	breed:    'The seed being worked towards. Pick one yourself, or leave it on Auto and the assistant chooses - it ranks by chance times how many further seeds the pick would unblock, rather than by raw odds, because chasing the best odds alone gets stuck.',
	boost:    'Which bonus to maximise. The layout is scored by running the game\'s own effect calculation on it, so plot interactions and penalties are exact.',
	layout:   'What the assistant wants planted. One colour per species; dashed squares are deliberately left empty, because mutations can only land on an empty tile. Blank squares are tiles your farm level has not unlocked yet. Hover a square for the plant. To plant a different breeding layout, customize it in the Layouts tab.',
	yield:    'How many of the target seed this layout is expected to produce per garden step, averaged over the cycle the plants really live. It accounts for rival mutations crowding the tile - the game plants only one winner per tile, chosen at random from everything that rolled successfully - and for the fact that a plant only counts as a parent while it is mature, which for a slow grower is a small part of its life.',
	step:     'The garden only changes on a step - every 5 minutes on dirt, 3 on fertilizer, 15 on clay. The assistant acts then and does nothing in between.',
	clearYes: 'Uproot them now and plant the layout. Mature ones still bank their seed as they go.',
	clearNo:  'Leave them growing. The layout fills in around them as tiles free up on their own, and you will not be asked again for this layout.',
	clearRow: 'The assistant will not take a plant you might still want without asking. This question covers only plants that would otherwise keep living - weeds, immortals, species you have not banked yet and anything already about to expire (harvested anyway while mature plants are) are never part of it.',
	setBank:  'A species you have never banked is worth more than any layout, so it is harvested the moment it matures. This is the only thing that actually unlocks a seed - harvesting early banks nothing.',
	setMature:'Take a mature plant on the last step it is certainly still alive, so the tile frees up instead of rotting. The margin is one of the plant\'s own growth steps, not a fixed slice of age: baker\'s wheat covers eight age in a step and a duketater half of one, and a duketater is not even mature until 95.',
	setPlan:  'Sow the layout into empty tiles as they open, spending at most 15% of your cookies per step.',
	setClearNow:'Uproot a plant the layout does not want as soon as it sprouts, instead of letting it mature first. Without this, a banked fungus that spreads into a mutation slot holds it until it matures - and seeds its neighbours meanwhile. Only species you have banked: a new one is still left to ripen, and the layout\'s own plants, immortals and weeds are never touched.',
	setWeeds: 'Uproot meddleweed the layout has no use for - but only once it has ripened, because the fungus spore it drops when pulled scales with its age.',
	setAsk:   'Ask before uprooting anything that would otherwise keep growing. Turn it off and the assistant clears straight through.',
	tabLayouts:'Draw your own layouts with any seed and keep as many as you like. A layout made for a breeding recipe can be used for breeding in place of the assistant\'s, and any layout can be grown as drawn in Plant mode.',
	library:  'Your own layouts first, then the assistant\'s breeding layout for every seed. Click a name to open it in the editor. A layout made for a recipe can be put to use for breeding; any layout can be marked with Plant this for Plant mode to grow.',
	editor:   'Pick a seed in the Brush beside the grid, then click tiles to paint them. Every click is kept at once - there is nothing to save. Blank squares are tiles your farm level has not unlocked yet.',
	palette:  'The seed a click paints. Greyed seeds are not unlocked yet: you can draw them, and they are planted once you bank the seed.',
	libNew:   'Start a new layout on a blank plot.',
	libRename:'Rename the layout open in the editor.',
	libDup:   'Copy the layout open in the editor, to try a variation without losing the original.',
	libDelete:'Delete the layout open in the editor. Asks first.',
	libExport:'All your layouts as JSON text, to copy and keep somewhere or share.',
	libImport:'Paste layouts exported earlier. The text is checked in full before anything is added; a name already taken gets a number.',
	custPreview:'The layout the assistant worked out for the seed it is breeding right now.',
	customize:'Copy this layout into your library, linked to this recipe. Reshape it in the editor, and from then on the assistant plants your version whenever it breeds this seed with these parents on a plot this size.',
	stopUse:  'Stop using this layout for its recipe. It stays in your library, still marked with the seed it was made for, and the assistant goes back to its own.',
	useBreed: 'Have the assistant plant this layout in place of its own whenever it breeds this seed with this recipe on a plot this size. Any other layout in use for the same recipe is taken out of use.',
	plantThis:'Make this the layout Plant mode grows, exactly as drawn: empty tiles are sown, expired plants replanted, immortals left be. One layout at a time - this takes the mark from any other. Switch to the Plant tab to start.',
	unlocks:  'Some plants drop a garden upgrade when harvested mature. Which ones, and at what chance, is read out of the plants themselves at startup. The plot goes to the banked species expected to drop the most per garden step - its chance divided by the steps it takes to mature, so a quick grower beats a slow one with better odds - and all of it to one species at a time: every drop is a fresh roll, so splitting the plot only delays the first. A seed you have not banked is not planted - breed it first. Luck is not guessed at; the plot is simply kept planted until the game grants the upgrade.',
	stopPlant:'Stop growing this layout in Plant mode. It stays in your library; Plant mode has nothing to grow until you mark another.',
	badge:    'The seed this layout was made for - breeding it with this recipe on a plot of this size. Green while it is in use and stands in for the assistant\'s own layout.',
	libDefault:'The assistant\'s layout for breeding this seed on your plot as it is now. It is worked out when you open it and never saved, so it keeps up as your plot grows. Paint a tile or press any button and it becomes a layout of your own, which then takes its place here; delete that and this default comes back.',
	libReset: 'Replace this layout\'s drawing with the assistant\'s layout for its recipe on your plot as it is now. Asks first. The name, and whether it is used for breeding, stay as they are.'
};

/*
 * Hover text goes through the game's own tooltip (Game.tooltip), not the
 * title attribute: a title shows the OS's grey box after a delay and wants
 * the help cursor, while the game's framed box appears at once and looks
 * like every other tooltip on screen.
 *
 * Markup only marks what to show - data-help="<HELP key>" for the fixed
 * texts, data-tip="<text>" for the ones written per plant or per layout -
 * and one pair of delegated handlers on the panel (onPanelOver /
 * onPanelOut) hands it to the game. No per-element onMouseOver strings, as
 * Game.getTooltip writes them: the panel rewrites its grids constantly, and
 * delegation means a freshly written tile needs nothing attached.
 */
function tip(key) {
	return HELP[key] ? ' data-help="' + key + '"' : '';
}

/** Hover text written on the spot, e.g. a plant name; escaped like any markup. */
function tipText(text) {
	return ' data-tip="' + esc(text) + '"';
}

/** The text an element's hover should show, or '' for none. */
function hoverText(el) {
	var key = el.getAttribute('data-help');
	if (key && HELP[key]) return HELP[key];
	return el.getAttribute('data-tip') || '';
}

/**
 * The element the tooltip is currently drawn for, so leaving it hides only
 * a tooltip this panel drew and never one the game drew for something else.
 */
var tipFrom = null;

function gameTooltip() {
	return (typeof Game !== 'undefined' && Game && Game.tooltip && typeof Game.tooltip.draw === 'function')
		? Game.tooltip : null;
}

function onPanelOver(e) {
	var tt = gameTooltip();
	if (!tt || !e.target || !e.target.closest) return;
	var el = e.target.closest('[data-help],[data-tip]');
	// Already showing for this element: the pointer only crossed into a child.
	if (!el || (el === tipFrom && tt.on && !tt.shouldHide)) return;
	tipFrom = el;
	// Game.getDynamicTooltip's idiom (dynamic=1, then draw with a function)
	// rather than a fixed string, for two reasons: the text is read from the
	// element each time, so a label the refresh retitles (the Breed / Boost
	// choice) is current while hovered; and a tile the refresh has thrown
	// away returns '', which the game renders as an invisible tooltip rather
	// than one pinned to a node that is gone.
	// The text is escape()d because the game unescape()s whatever it is
	// given - Game.getTooltip escapes for the same reason - and help texts
	// with a percent sign ("15% of your cookies") would otherwise be mangled.
	// Origin 'this' is what the garden's own seeds, tools and tiles use: the
	// box sits centred above the hovered element, and when there is no room
	// above it moves beside the element instead, never off the bottom of the
	// screen - which matters for a panel that lives at the foot of the page.
	tt.dynamic = 1;
	tt.draw(el, function () {
		if (!el.isConnected) return '';
		var text = hoverText(el);
		return text ? escape('<div id="tooltipGreenhouse" style="padding:8px 4px;min-width:160px;max-width:320px;' +
			'font-size:11px;text-align:center;">' + esc(text) + '</div>') : '';
	}, 'this');
}

function onPanelOut(e) {
	var tt = gameTooltip();
	if (!tt || !tipFrom) return;
	// Moving onto a child of the same element is not leaving it.
	var to = e.relatedTarget;
	if (to && tipFrom.contains && tipFrom.contains(to)) return;
	// Only hide what this panel drew; the game may have drawn another since.
	if (tt.from === tipFrom) tt.shouldHide = 1;
	tipFrom = null;
}

function injectCSS() {
	if (document.getElementById('grandpasGreenhouseCSS')) return;
	var st = document.createElement('style');
	st.id = 'grandpasGreenhouseCSS';
	st.textContent = buildCSS();
	document.head.appendChild(st);
}

/**
 * The Settings view: the toggles in SETTINGS_META, filed under their groups,
 * each with its help text written out under the label - on a page of its
 * own there is room to say what a switch does, not only on hover. The hover
 * stays for players who have learnt to reach for it everywhere else.
 */
function settingsTabHTML() {
	var groups = [], byGroup = {};
	for (var i = 0; i < SETTINGS_META.length; i++) {
		var g = SETTINGS_META[i].group;
		if (!byGroup[g]) { byGroup[g] = []; groups.push(g); }
		byGroup[g].push(SETTINGS_META[i]);
	}
	var html = '<div class="ggPane ggSetPane">' +
		'<div class="ggHead"' + tip('settings') + '>Settings</div>' +
		'<div class="ggSetGrid">';
	for (var j = 0; j < groups.length; j++) {
		html += '<div class="ggSetGroup"><div class="ggSubHead">' + groups[j] + '</div>';
		for (var k = 0; k < byGroup[groups[j]].length; k++) {
			var meta = byGroup[groups[j]][k];
			html += '<div class="ggSetItem"' + tip(meta.help) + '>' +
				// The real checkbox keeps the state and fires the change the
				// panel listens for; the switch is its drawn face, a label for
				// it, so a click on the switch or the text flips the box.
				'<div class="ggSet"><input type="checkbox" class="ggSwIn" id="ggSet-' + meta.key +
					'" data-key="' + meta.key + '">' +
				'<label class="ggSwitch" for="ggSet-' + meta.key + '"></label>' +
				'<label for="ggSet-' + meta.key + '">' + meta.label + '</label></div>' +
				'<div class="ggSetHelp">' + esc(HELP[meta.help] || '') + '</div></div>';
		}
		html += '</div>';
	}
	html += '</div>' +
		// What the toggles are acting on right now, so the page answers "what
		// will this change?" without switching back to the assistant.
		'<span class="ggNote" id="ggModeHint"></span>' +
		// The last-resort switch: a wiped state is how a player digs themself
		// out when something about the saved data went wrong. Confirmed in
		// place, like the clearance question - the dialog box lives in the
		// Layouts view and this page must not depend on it.
		'<div class="ggRow" style="margin:6px 0 0 0;">' +
			'<div class="ggBtn ggDanger" data-act="wipe" id="ggWipeBtn"' + tip('wipe') + '>Reset mod data</div></div>' +
		'<div class="ggAlert" id="ggWipeRow" style="display:none;">' +
			'<span class="ggAlertText">Reset all mod data? Settings go back to their defaults and your ' +
			'drawn layouts and counters are deleted. Your garden is not touched. This cannot be undone.</span>' +
			'<div class="ggRow" style="margin:0;">' +
				'<div class="ggBtn" data-act="wipeYes">Reset everything</div>' +
				'<div class="ggBtn" data-act="wipeNo">Keep my data</div></div></div>' +
		'</div>';
	return html;
}

/**
 * The clean start the Reset button promises: every piece of state a save can
 * carry or a session can accumulate, back to first-run. The measured recipe
 * table survives - it comes from the game, not from the player.
 */
function wipeData(m) {
	for (var k in DEFAULTS) S[k] = DEFAULTS[k];
	S.layouts = [];
	S.tab = 'settings';   // stay where the player is, not where DEFAULTS points
	for (var s in stats) stats[s] = 0;
	clearDecision = {};
	virtGrids = {};
	libSel = ''; libVirt = ''; brush = null; dialog = null; libNote = '';
	plan = null; lastStep = -1; lastSoil = null; seedGridKey = '';
	statusText = 'mod data reset';
	showWipeConfirm = false;
	if (m) rebuildPlan(m, true);
}

/**
 * Puts the switches back in line with S - a load or the API may have moved
 * one - and names the mode they are acting on.
 */
function refreshSettings() {
	for (var i = 0; i < SETTINGS_META.length; i++) {
		var input = document.getElementById('ggSet-' + SETTINGS_META[i].key);
		if (input) input.checked = !!S[SETTINGS_META[i].key];
	}
	var mode = modeByKey(S.mode);
	setText('ggModeHint', 'Working in ' + mode.label + ': ' + mode.hint);
	var wipeRow = document.getElementById('ggWipeRow');
	if (wipeRow) wipeRow.style.display = showWipeConfirm ? '' : 'none';
}

/** For text a player typed or pasted, which ends up inside markup and attributes. */
function esc(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The fixed frame of the assistant's view, which every mode tab shows;
 * refreshPanel fills in the parts that change. One framed pane in the
 * Layouts tab's language, under the one heading Plan: a plan here is both
 * what the assistant is after and the layout that gets it, and a second
 * heading over a picture that only illustrates the first would split one
 * answer in two. The question side (the Breed / Boost choice, the recipe or
 * the mode's own line, the clearance question) sits beside the plot side
 * (the preview, its colour key and how the garden is doing) rather than
 * above it, because the bottom bar is short and wide and stacking them would
 * push the status off its bottom. The modes without a choice (Off, Tend,
 * Plant - whose layout is picked in Layouts - and Unlocks) hide the choice
 * rows and leave one line of text, so the frame is the same in all six and
 * only its contents change.
 *
 * The preview is a picture, not an editor: breed layouts are reshaped in the
 * Layouts tab, so there is one place a layout changes and one answer to what
 * gets planted.
 */
function assistantTabHTML() {
	return '<div class="ggPane ggAsstPane">' +
			// Named after what the mode is doing, not the abstract "Plan":
			// refreshPanel fills it (Breeding <seed> / Boosting / Planting
			// <layout> / Tending / Off), so it starts empty rather than with a
			// label no mode uses.
			'<div class="ggHead" id="ggAsstHead"' + tip('plan') + '></div>' +
			'<div class="ggRow ggBody">' +
				'<div class="ggCol ggPlanCol">' +
					'<div id="ggChoiceRow" class="ggRow">' +
						'<span class="ggStat" id="ggChoiceLabel"></span>' +
						'<select id="ggChoice"></select>' +
						'<span class="ggStat" id="ggChoiceInfo"></span>' +
					'</div>' +
					'<div id="ggSeedRow" class="ggRow" style="display:none;">' +
						'<div class="ggSeedGrid" id="ggSeedGrid"></div>' +
					'</div>' +
					'<div class="ggStat" id="ggRecipe"></div>' +
					'<div id="ggClearRow" class="ggRow ggAlert" style="display:none;"' + tip('clearRow') + '>' +
						'<span class="ggAlertText" id="ggClearText"></span>' +
						'<div class="ggBtn" data-act="clearYes"' + tip('clearYes') + '>Clear them</div>' +
						'<div class="ggBtn" data-act="clearNo"' + tip('clearNo') + '>Keep them</div>' +
					'</div>' +
				'</div>' +
				'<div class="ggCol ggPlotCol">' +
					// The preview with its colour key beside it, as the editor's
					// grid has its brush.
					'<div class="ggRow ggBody">' +
						'<div' + tip('layout') + '><div class="ggGrid" id="ggGrid"></div></div>' +
						'<div class="ggCol" id="ggLegend"></div>' +
					'</div>' +
					'<div class="ggStat" id="ggStatus"' + tip('step') + '></div>' +
				'</div>' +
			'</div>' +
		'</div>';
}

/**
 * The fixed frame of the Layouts tab; refreshLayouts fills in the parts that
 * change. Two framed halves, as in the game's Manage mods prompt: the
 * Library lists the layouts and acts on the one selected, the Editor draws
 * it. The dialog sits above both, full width, because the export text needs
 * the room and a question should not hide inside one half.
 */
function layoutsTabHTML() {
	return '<div id="ggDialog" class="ggRow ggAlert ggDialog" style="display:none;"></div>' +
		'<div class="ggSplit">' +
			'<div class="ggPane ggLibPane">' +
				'<div class="ggHead"' + tip('library') + '>Library</div>' +
				'<div class="ggListBox"><div id="ggLibrary" class="ggList"></div></div>' +
				// What can be done to the selected layout, written by
				// refreshLayouts - one row here instead of a set of buttons
				// repeated on every entry of the list.
				'<div class="ggRow" id="ggLibActions"></div>' +
				'<div class="ggRow">' +
					'<div class="ggBtn" data-act="libNew"' + tip('libNew') + '>New</div>' +
					'<div class="ggBtn" data-act="libImport"' + tip('libImport') + '>Import</div>' +
					'<div class="ggBtn" data-act="libExport"' + tip('libExport') + '>Export</div>' +
				'</div>' +
				'<span class="ggStat" id="ggLibNote"></span>' +
			'</div>' +
			'<div class="ggPane ggEdPane">' +
				'<div class="ggHead"' + tip('editor') + '>Editor</div>' +
				'<div class="ggStat" id="ggEditTitle"></div>' +
				// The brush sits beside the grid it paints, which also keeps the
				// pane inside the bar's height budget.
				'<div class="ggRow ggBody">' +
					'<div' + tip('editor') + '><div class="ggGrid ggBig" id="ggEditGrid"></div></div>' +
					'<div class="ggCol ggGrow">' +
						'<div class="ggCol"' + tip('palette') + '><span class="ggStat">Brush:</span>' +
							'<div class="ggSeedGrid" id="ggPalette"></div></div>' +
						'<div class="ggCol" id="ggEditLegend"></div>' +
					'</div>' +
				'</div>' +
				// Last, and only while breeding: the assistant's own layout,
				// offered as a starting point for one of the player's.
				'<div id="ggCustRow" class="ggRow ggBody" style="display:none;">' +
					'<div class="ggGrid" id="ggCustGrid"' + tip('custPreview') + '></div>' +
					'<div class="ggCol">' +
						'<span class="ggStat" id="ggCustText"></span>' +
						'<div class="ggBtn" data-act="customize" id="ggCustBtn"' + tip('customize') + '>Customize</div>' +
					'</div>' +
				'</div>' +
			'</div>' +
		'</div>';
}

/**
 * The one open question or text box in the Layouts tab. Kept in the panel
 * rather than a browser prompt, the same way the clearance question is:
 * a native dialog would freeze the game loop while it waits.
 */
function dialogHTML() {
	var d = dialog;
	if (!d) return '';
	var ok = function (label) { return '<div class="ggBtn" data-act="dlgOk">' + label + '</div>'; };
	var cancel = '<div class="ggBtn" data-act="dlgCancel">Cancel</div>';
	var input = '<input type="text" id="ggDlgInput" maxlength="' + NAME_MAX + '" value="' + esc(d.value || '') + '">';
	var body;
	if (d.kind === 'new') {
		body = '<span class="ggAlertText">Name for the new layout:</span>' + input +
			'<div class="ggRow" style="margin:0;">' + ok('Create') + cancel + '</div>';
	} else if (d.kind === 'rename') {
		body = '<span class="ggAlertText">Rename &quot;' + esc(d.name) + '&quot; to:</span>' + input +
			'<div class="ggRow" style="margin:0;">' + ok('Rename') + cancel + '</div>';
	} else if (d.kind === 'delete') {
		body = '<span class="ggAlertText">Delete &quot;' + esc(d.name) + '&quot;? This cannot be undone.' +
			(plan && plan.override === d.name
				? ' It stands in for the breed layout, so the assistant goes back to its own.' : '') +
			(S.plantLayout === d.name ? ' It is the layout Plant mode grows, so Plant mode has nothing to grow ' +
				'until you mark another.' : '') + '</span>' +
			'<div class="ggRow" style="margin:0;">' + ok('Delete') + cancel + '</div>';
	} else if (d.kind === 'reset') {
		body = '<span class="ggAlertText">Set &quot;' + esc(d.name) + '&quot; back to the assistant\'s layout for ' +
			'your plot as it is now? Your changes to its drawing are lost. Its name, and whether it is used for ' +
			'breeding, stay as they are.</span>' +
			'<div class="ggRow" style="margin:0;">' + ok('Set to default') + cancel + '</div>';
	} else if (d.kind === 'export') {
		body = '<span class="ggAlertText">All your layouts as JSON. Copy the text and keep it somewhere:</span>' +
			'<textarea id="ggDlgText" readonly>' + esc(exportLayouts()) + '</textarea>' +
			'<div class="ggRow" style="margin:0;"><div class="ggBtn" data-act="dlgCancel">Close</div></div>';
	} else {
		body = '<span class="ggAlertText">Paste layouts exported earlier - a list, or a single layout:</span>' +
			'<textarea id="ggDlgText"></textarea>' +
			'<div class="ggRow" style="margin:0;">' + ok('Import') + cancel + '</div>';
	}
	// The message has its own element, written with setText, so an error does
	// not rewrite the box and throw away what was pasted into it.
	return body + '<span class="ggWarn" id="ggDlgMsg"></span>';
}

function openDialog(m, kind) {
	var def = editorDefault(m), lay = editorLayout();
	libNote = '';
	if (kind === 'new') dialog = {kind: kind, value: defaultLayoutName()};
	// Renaming a default stores it, but only once the new name is confirmed:
	// a cancelled rename changed nothing, so it leaves nothing behind.
	else if (kind === 'rename' && def) dialog = {kind: kind, name: def.name, value: def.name, seed: def.seed};
	else if (kind === 'rename' && lay) dialog = {kind: kind, name: lay.name, value: lay.name};
	else if (kind === 'delete' && lay) dialog = {kind: kind, name: lay.name};
	else if (kind === 'reset' && lay && canReset(m, lay)) dialog = {kind: kind, name: lay.name};
	else if (kind === 'export' || kind === 'import') dialog = {kind: kind};
}

/** Set to default is offered for a stored layout whose recipe the mod can still work out. */
function canReset(m, lay) {
	return !!(m && lay && typeof lay.recipe === 'string' && recipeOfKey(m, lay.recipe));
}

/** What the dialog's confirm button does - each case one of the library functions. */
function dialogOk(m) {
	var d = dialog;
	if (!d) return;
	var input = document.getElementById('ggDlgInput'), box = document.getElementById('ggDlgText');
	if (d.kind === 'new') {
		createLayout(input ? input.value : '');
	} else if (d.kind === 'rename') {
		var from = d.seed ? materializeDefault(m, d.seed) : layoutByName(d.name);
		if (from) renameLayout(m, from.name, input ? input.value : from.name);
	} else if (d.kind === 'delete') {
		deleteLayout(m, d.name);
	} else if (d.kind === 'reset') {
		resetToDefault(m, d.name);
	} else if (d.kind === 'import') {
		var res = importLayouts(m, box ? box.value : '');
		if (!res.ok) { d.msg = res.msg; return; }
		libNote = res.msg;
	}
	dialog = null;
}

/** A mode tab's resting class: the last mode closes the mode strip (.ggTabEnd). */
function modeTabClass(i) {
	return 'ggBtn ggTab' + (i === MODES.length - 1 ? ' ggTabEnd' : '');
}

function buildPanel(host) {
	injectCSS();
	var panel = document.createElement('div');
	panel.id = PANEL_ID;

	var tabs = '';
	for (var i = 0; i < MODES.length; i++) {
		tabs += '<div class="' + modeTabClass(i) + '" data-act="mode" data-mode="' + MODES[i].key + '"' +
			tipText(MODES[i].hint) + ' id="ggMode-' + MODES[i].key + '">' + MODES[i].label + '</div>';
	}

	// A rebuilt panel starts empty, so anything remembered about the old DOM
	// is stale - both caches must reset or setHTML skips the first write.
	htmlCache = {};
	seedGridKey = '';

	// Layouts closes the bar, set apart by a small gap (see .ggTabApart): it
	// only switches the view and leaves the mode alone.
	tabs += '<div class="ggBtn ggTab ggTabApart" data-act="tab" data-tab="layouts" id="ggTab-layouts"' +
		tip('tabLayouts') + '>Layouts</div>';
	// Settings follows it in the same strip: another page of the panel, not
	// a box that pushes the open view down when it appears.
	tabs += '<div class="ggBtn ggTab" data-act="tab" data-tab="settings" id="ggTab-settings"' +
		tip('settings') + '>Settings</div>';

	panel.innerHTML =
		'<div class="ggRow">' +
			'<span class="ggTitle">GRANDPA&#39;S GREENHOUSE' +
				'<span class="ggVer">v' + VERSION + '</span></span>' +
			'<div class="ggTabs">' + tabs + '</div>' +
			'<span class="ggStat" id="ggProgress"' + tip('progress') + '></span>' +
		'</div>' +
		'<div id="ggTabAssistant">' + assistantTabHTML() + '</div>' +
		'<div id="ggTabLayouts" style="display:none;">' + layoutsTabHTML() + '</div>' +
		'<div id="ggTabSettings" style="display:none;">' + settingsTabHTML() + '</div>';

	host.parentNode.insertBefore(panel, host.nextSibling);
	panel.addEventListener('click', onPanelClick);
	panel.addEventListener('change', onPanelChange);
	panel.addEventListener('mouseover', onPanelOver);
	panel.addEventListener('mouseout', onPanelOut);
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
		// A mode tab is also the way back to the assistant's view: there is no
		// separate Assistant tab any more.
		setTab('assistant');
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
	} else if (act === 'tab') {
		setTab(el.getAttribute('data-tab'));
	} else if (act === 'libSel' || act === 'useBreed' || act === 'stopUse' || act === 'plantThis' ||
			act === 'stopPlant') {
		// A default's row and buttons name it by seed. Selecting one only opens
		// it; anything else is a change to it, so it is stored first.
		var seed = el.getAttribute('data-seed'), lay = null;
		if (seed !== null) {
			if (act === 'libSel') { if (m) selectDefault(m, seed); }
			else lay = materializeDefault(m, seed);
		} else {
			lay = S.layouts[parseInt(el.getAttribute('data-i'), 10)];
		}
		if (lay && act === 'libSel') selectLayout(m, lay.name);
		if (lay && act === 'useBreed') useForBreeding(m, lay.name);
		if (lay && act === 'stopUse') stopUsing(m, lay.name);
		if (lay && act === 'plantThis') plantThis(m, lay.name);
		if (lay && act === 'stopPlant') stopPlanting(m, lay.name);
	} else if (act === 'customize') {
		if (m) customizeCurrentPlan(m);
	} else if (act === 'brush') {
		setBrush(el.getAttribute('data-seed') || '');
	} else if (act === 'paint') {
		if (m) paintTile(m, parseInt(el.getAttribute('data-x'), 10), parseInt(el.getAttribute('data-y'), 10),
			currentBrush(m));
	} else if (act === 'libNew') {
		openDialog(m, 'new');
	} else if (act === 'libRename') {
		openDialog(m, 'rename');
	} else if (act === 'libDelete') {
		openDialog(m, 'delete');
	} else if (act === 'libReset') {
		openDialog(m, 'reset');
	} else if (act === 'libExport') {
		openDialog(m, 'export');
	} else if (act === 'libImport') {
		openDialog(m, 'import');
	} else if (act === 'libDup') {
		var dup = editorLayout() || materializeDefault(m, libVirt);
		if (dup) duplicateLayout(dup.name);
	} else if (act === 'dlgOk') {
		dialogOk(m);
	} else if (act === 'dlgCancel') {
		dialog = null;
	} else if (act === 'wipe') {
		showWipeConfirm = true;
	} else if (act === 'wipeNo') {
		showWipeConfirm = false;
	} else if (act === 'wipeYes') {
		wipeData(m);
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

/** Points an element's hover at a HELP entry; see tip() for why not a title. */
function setHelp(id, key) {
	var el = document.getElementById(id);
	if (el && el.getAttribute('data-help') !== key) el.setAttribute('data-help', key);
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
		'data-seed="*"' + tipText('Let the assistant choose - it ranks by chance x how many ' +
		'further seeds the pick unblocks, and will clear the plot to farm meddleweed when ' +
		'that beats every route it can sow.') + '>Auto</div>';

	for (var i = 0; i < missing.length; i++) {
		var key = missing[i], p = m.plants[key], rec = bestRecipeFor(m, key);
		var sel = chosen ? (key === chosen) : (key === active);
		var hover = p.name + ' - ' + (rec
			? fmtPct(rec.chance) + ' from ' + recipeText(m, rec)
			: 'no route you can sow yet');
		html += '<div class="ggSeed' + (sel ? ' ggSel' : '') + (rec ? '' : ' ggBlocked') +
			'" data-act="pick" data-seed="' + key + '"' + tipText(hover) + '>' +
			'<div class="ggSeedIcon" style="background-position:0px -' + (p.icon * 48) + 'px;"></div>' +
			'</div>';
	}
	return html;
}

/** Colours in order of first appearance, across one grid and optionally a second. */
function speciesColors(grid, tiles, also) {
	var order = [], map = {}, grids = also ? [grid, also] : [grid];
	for (var g = 0; g < grids.length; g++) {
		for (var t = 0; t < tiles.length; t++) {
			var key = grids[g][tiles[t][1]][tiles[t][0]];
			if (key && !map[key]) { map[key] = PLAN_COLORS[order.length % PLAN_COLORS.length]; order.push(key); }
		}
	}
	return {map:map, order:order};
}

/**
 * What a customized layout is worth, relative to the layout the assistant
 * chose. A ratio rather than a second rate, because both rates are usually
 * "one every few hundred steps" and two numbers like that are hard to compare.
 */
function overrideDelta(p) {
	if (!(p.origScore > 0)) return '(your layout - the assistant\'s layout expected nothing)';
	var d = p.score / p.origScore - 1;
	return '(your layout: ' + (d >= 0 ? '+' : '') + (d * 100).toFixed(0) + '% vs the assistant)';
}

/** Unlocks mode's line in the assistant's pane. */
function huntText(m) {
	if (!plan) return modeByKey('unlocks').hint;
	var names = [];
	for (var i = 0; plan.locked && i < plan.locked.length; i++) names.push(plan.locked[i].name);
	var later = names.length ? ' Bank ' + names.join(', ') + ' to hunt ' +
		(upgradeCount(plan.locked) === 1 ? 'the upgrade it drops' : 'the upgrades they drop') + ' - Breed mode can.' : '';
	if (!plan.hunt) {
		return names.length ? 'Every upgrade left drops from a seed you have not banked yet.' + later
			: 'Every garden upgrade a plant can drop is unlocked. Nothing left to hunt.';
	}
	return 'Growing ' + plan.hunt.name + ' on every tile and harvesting it as it matures: ' +
		fmtPct(plan.hunt.chance) + ' a mature harvest to drop ' + plan.hunt.upgrades.join(' and ') + '. ' +
		plan.left + ' garden upgrade' + (plan.left === 1 ? '' : 's') + ' still to find.' + later;
}

function refreshPanel() {
	var m = garden();
	if (!m || !document.getElementById(PANEL_ID)) return;

	// One tab is lit: the current mode while the assistant's view is open,
	// Layouts or Settings while that is. With either open the current mode
	// keeps only a pip (ggCur), so it is still plain what the assistant is doing.
	var onA = (S.tab === 'assistant');
	for (var i = 0; i < MODES.length; i++) {
		var btn = document.getElementById('ggMode-' + MODES[i].key);
		if (btn) btn.className = modeTabClass(i) + (S.mode === MODES[i].key ? (onA ? ' ggOn' : ' ggCur') : '');
	}
	var layoutsBtn = document.getElementById('ggTab-layouts');
	if (layoutsBtn) layoutsBtn.className = 'ggBtn ggTab ggTabApart' + (S.tab === 'layouts' ? ' ggOn' : '');
	var settingsBtn = document.getElementById('ggTab-settings');
	if (settingsBtn) settingsBtn.className = 'ggBtn ggTab' + (S.tab === 'settings' ? ' ggOn' : '');
	var paneA = document.getElementById('ggTabAssistant'), paneL = document.getElementById('ggTabLayouts');
	var paneS = document.getElementById('ggTabSettings');
	if (paneA) paneA.style.display = (S.tab === 'assistant') ? '' : 'none';
	if (paneL) paneL.style.display = (S.tab === 'layouts') ? '' : 'none';
	if (paneS) paneS.style.display = (S.tab === 'settings') ? '' : 'none';

	var tiles = unlockedTiles(m);
	var have = unlockedCount(m), all = m.plantsN;
	var used = 0;
	for (var t = 0; t < tiles.length; t++) if (m.plot[tiles[t][1]][tiles[t][0]][0] > 0) used++;
	setText('ggProgress', 'Seeds ' + have + '/' + all + '  -  plot ' + used + '/' + tiles.length + ' used');

	// The Settings view is only synced while it is on screen, like the editor.
	if (S.tab === 'settings') refreshSettings();

	// The pane says what the assistant is doing right now, because a static
	// "Plan" confused more than it explained.
	var headText = 'Off';
	if (S.mode === 'breed') {
		var ht = (plan && plan.target && m.plants[plan.target]) ? m.plants[plan.target].name : '';
		headText = ht ? 'Breeding ' + ht : 'Breeding';
	} else if (S.mode === 'boost') headText = 'Boosting';
	else if (S.mode === 'plant') headText = (plan && plan.layout) ? 'Planting "' + plan.layout + '"' : 'Planting';
	else if (S.mode === 'unlocks') headText = (plan && plan.hunt) ? 'Hunting ' + plan.hunt.upgrades.join(', ') : 'Unlocks';
	else if (S.mode === 'tend') headText = 'Tending';
	setText('ggAsstHead', headText);

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
			setHelp('ggChoiceLabel', 'boost');
			setHelp('ggChoice', 'boost');
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
			setHelp('ggChoiceLabel', 'breed');
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
			setText('ggRecipe', (rec ? ('needs ' + recipeText(m, rec)) :
				(t2 ? 'no route you can sow yet - bank one of its parents first' : '')) +
				(plan && plan.override ? '  -  planting your layout "' + plan.override + '" instead of the assistant\'s' : ''));
		}
	} else {
		choiceRow.style.display = 'none';
		seedRow.style.display = 'none';
		// Plant has no choice of its own - the layout is picked in Layouts -
		// so its line says which one, or where to pick one. Unlocks has none
		// either: its line says what is hunted and how much is left.
		setHelp('ggRecipe', S.mode === 'unlocks' ? 'unlocks' : '');
		if (S.mode === 'unlocks') setText('ggRecipe', huntText(m));
		else if (S.mode === 'plant') {
			setText('ggRecipe', (plan && plan.layout)
				? 'Growing your layout "' + plan.layout + '" exactly as drawn. Change it, or mark another, ' +
					'in the Layouts tab.'
				: 'No layout is marked for planting. Open Layouts, pick one and press Plant this.');
		} else setText('ggRecipe', modeByKey(S.mode).hint);
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
		// Colours follow the assistant's own grid while a customized layout
		// stands in for it, so painting that layout in the editor keeps each
		// species its colour here and the legend its order.
		var bred = breedLayoutPlan();
		var cols = (bred && bred.origGrid)
			? speciesColors(bred.origGrid, tiles, grid) : speciesColors(grid, tiles);
		for (var y = 0; y < 6; y++) {
			for (var x = 0; x < 6; x++) {
				if (!m.isTileUnlocked(x, y)) { html += '<div class="ggCell ggLocked"></div>'; continue; }
				var key = grid[y][x];
				if (!key) {
					html += '<div class="ggCell ggHole"' +
						tipText(S.mode === 'plant' ? 'kept empty' : 'left empty for mutations') + '></div>';
					continue;
				}
				html += '<div class="ggCell" style="background:' + cols.map[key] +
					';border-color:' + cols.map[key] + ';"' + tipText(m.plants[key].name +
					(m.plants[key].unlocked ? '' : ' (not unlocked yet - waits until you bank it)')) + '></div>';
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
		lines.push('<span' + tip('yield') + '>Expected ' +
			fmtRate(plan.score) + (plan.override ? ' ' + overrideDelta(plan) : '') + '</span>');
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

	// The editor is only drawn while it is on screen; a hidden tab has nothing
	// to keep current.
	if (S.tab === 'layouts') refreshLayouts(m, tiles);
}

/**
 * The palette, in the game's own order and with the game's own seed packets.
 * Every seed that can be sown is offered, unlocked or not - a layout drawn
 * ahead of the collection is a plan for it, and the tiles fill in as the
 * seeds are banked.
 */
function paletteHTML(m) {
	var cur = currentBrush(m);
	var html = '<div class="ggSeed ggAuto' + (cur === '' ? ' ggSel' : '') + '" data-act="brush" data-seed="" ' +
		tipText('Empty - paint a tile back to bare soil') + '>Empty</div>';
	for (var i = 0; i < m.plantsById.length; i++) {
		var p = m.plantsById[i];
		if (!p.plantable) continue;
		var hover = p.name + (p.unlocked ? '' : ' - not unlocked yet; drawn tiles stay empty until you bank it');
		html += '<div class="ggSeed' + (cur === p.key ? ' ggSel' : '') + (p.unlocked ? '' : ' ggBlocked') +
			'" data-act="brush" data-seed="' + p.key + '"' + tipText(hover) + '>' +
			'<div class="ggSeedIcon" style="background-position:0px -' + (p.icon * 48) + 'px;"></div></div>';
	}
	return html;
}

/** A small read-only picture of a grid, drawn like the assistant view's preview. */
function smallGridHTML(m, grid, tiles) {
	var cols = speciesColors(grid, tiles), html = '';
	for (var y = 0; y < 6; y++) {
		for (var x = 0; x < 6; x++) {
			if (!m.isTileUnlocked(x, y)) { html += '<div class="ggCell ggLocked"></div>'; continue; }
			var key = grid[y][x];
			if (!key || !m.plants[key]) { html += '<div class="ggCell ggHole"></div>'; continue; }
			html += '<div class="ggCell" style="background:' + cols.map[key] + ';border-color:' + cols.map[key] +
				';"' + tipText(m.plants[key].name) + '></div>';
		}
	}
	return html;
}

function refreshLayouts(m, tiles) {
	// --- the assistant's breed layout, offered for customizing --------------
	var bred = breedLayoutPlan();
	var custRow = document.getElementById('ggCustRow');
	if (custRow) custRow.style.display = bred ? 'flex' : 'none';
	if (bred) {
		setHTML('ggCustGrid', smallGridHTML(m, bred.origGrid || bred.grid, tiles));
		setText('ggCustText', bred.override
			? bred.label + ': the assistant is planting your layout "' + bred.override + '" in place of this one.'
			: bred.label + ': the assistant\'s layout. Customize it to keep your own version for this recipe.');
		var custBtn = document.getElementById('ggCustBtn');
		// Once overridden, the place to change the layout is the linked one
		// in the editor; a second copy would only steal the link from it.
		if (custBtn) custBtn.style.display = bred.override ? 'none' : '';
	}

	// --- the library ------------------------------------------------------
	// The list only says what each layout is - its badge, green while in
	// use, and a tag on the one being planted. What to do with a layout is
	// asked of the selected one alone, in the action row under the list.
	// The default first: settling it may move the editor on to a stored twin.
	var selDef = editorDefault(m);
	var lib = '', sel = editorLayout();
	for (var i = 0; i < S.layouts.length; i++) {
		var l = S.layouts[i];
		// The tag marks the layout the plot is being planted from right now:
		// one in use for the recipe the assistant is breeding at this moment.
		var active = !!(bred && bred.override === l.name);
		var linked = typeof l.recipe === 'string', inUse = linked && l.use === true;
		lib += '<div class="ggLibRow' + (sel === l ? ' ggSel' : '') + '" data-act="libSel" data-i="' + i + '"' +
				tipText('Open in the editor') + '><span class="ggLibName">' + esc(l.name) + '</span>' +
			(linked ? '<span class="ggStat' + (inUse ? ' ggGood' : '') + '"' + tip('badge') + '>[' +
				esc(recipeBadge(m, l.recipe)) + ']</span>' : '') +
			(active ? '<span class="ggTag"' + tipText('The assistant is breeding with this layout right now') + '>planted</span>' : '') +
			// The layout marked for Plant mode carries its own tag, in every
			// mode, so the mark is visible before the Plant tab is pressed.
			(S.plantLayout === l.name ? '<span class="ggTag"' + tipText(S.mode === 'plant'
				? 'Plant mode is growing this layout right now'
				: 'The layout Plant mode grows - switch to the Plant tab to start') + '>plant</span>' : '') +
			'</div>';
	}
	// Then the defaults. A row needs only the name and the seed, so the list
	// costs no climb however many there are; a grid is worked out only for
	// the one opened in the editor.
	var defs = breedDefaults(m);
	for (var d = 0; d < defs.length; d++) {
		var e = defs[d];
		lib += '<div class="ggLibRow ggVirt' + (selDef && selDef.seed === e.seed ? ' ggSel' : '') +
				'" data-act="libSel" data-seed="' + e.seed + '"' + tip('libDefault') + '>' +
				'<span class="ggLibName">' + esc(e.name) + '</span>' +
				'<span class="ggStat">[' + esc(m.plants[e.seed].name) + ']</span></div>';
	}
	setHTML('ggLibrary', lib || '<div class="ggLibRow ggEmpty">none yet - press New to draw one</div>');

	var acts = '';
	if (selDef) {
		// A default can be used, planted, renamed or copied - each stores it
		// first - but not deleted: there is nothing stored to delete.
		acts = '<div class="ggBtn ggSmall" data-act="useBreed" data-seed="' + selDef.seed + '"' + tip('useBreed') +
				'>Use for breeding</div>' +
			'<div class="ggBtn ggSmall" data-act="plantThis" data-seed="' + selDef.seed + '"' + tip('plantThis') +
				'>Plant this</div>' +
			'<div class="ggBtn ggSmall" data-act="libRename"' + tip('libRename') + '>Rename</div>' +
			'<div class="ggBtn ggSmall" data-act="libDup"' + tip('libDup') + '>Duplicate</div>';
	} else if (sel) {
		var si = S.layouts.indexOf(sel);
		var selLinked = typeof sel.recipe === 'string', selInUse = selLinked && sel.use === true;
		// Only a layout made for a recipe can be used for breeding; any layout
		// can be marked for Plant mode, which grows it as drawn.
		acts = (selLinked ? (selInUse
				? '<div class="ggBtn ggSmall ggOn" data-act="stopUse" data-i="' + si + '"' + tip('stopUse') + '>Stop using</div>'
				: '<div class="ggBtn ggSmall" data-act="useBreed" data-i="' + si + '"' + tip('useBreed') +
					'>Use for breeding</div>') : '') +
			(S.plantLayout === sel.name
				? '<div class="ggBtn ggSmall ggOn" data-act="stopPlant" data-i="' + si + '"' + tip('stopPlant') +
					'>Stop planting</div>'
				: '<div class="ggBtn ggSmall" data-act="plantThis" data-i="' + si + '"' + tip('plantThis') +
					'>Plant this</div>') +
			'<div class="ggBtn ggSmall" data-act="libRename"' + tip('libRename') + '>Rename</div>' +
			'<div class="ggBtn ggSmall" data-act="libDup"' + tip('libDup') + '>Duplicate</div>' +
			(canReset(m, sel) ? '<div class="ggBtn ggSmall" data-act="libReset"' + tip('libReset') +
				'>Set to default</div>' : '') +
			'<div class="ggBtn ggSmall" data-act="libDelete"' + tip('libDelete') + '>Delete</div>';
	}
	var actRow = document.getElementById('ggLibActions');
	if (actRow) actRow.style.display = (sel || selDef) ? 'flex' : 'none';
	setHTML('ggLibActions', acts);
	setText('ggLibNote', libNote);

	// --- the dialog ---------------------------------------------------------
	var dlg = document.getElementById('ggDialog');
	if (dlg) dlg.style.display = dialog ? 'flex' : 'none';
	setHTML('ggDialog', dialogHTML());
	setText('ggDlgMsg', (dialog && dialog.msg) || '');
	if (dialog && !dialog.focused) {
		// Focused once, when it opens: the name ready to type over, the export
		// ready to copy.
		dialog.focused = true;
		var field = document.getElementById('ggDlgInput') || document.getElementById('ggDlgText');
		if (field && field.focus) { field.focus(); if (field.select) field.select(); }
	}

	// --- the editor ---------------------------------------------------------
	// A default is drawn exactly like a stored layout and takes the same
	// clicks; paintTile stores it on the first one.
	var lay = editorLayout();
	var grid = lay ? lay.grid : (selDef ? defaultGrid(m, selDef.recipe, selDef.rec) : null);
	var html = '', legend = '';
	if (grid) {
		setText('ggEditTitle', !lay
			? '"' + selDef.name + '" - the assistant\'s layout for your plot as it is now. Paint a tile or ' +
				'press a button to keep your own copy.'
			: 'Editing "' + lay.name + '"' +
			(bred && bred.override === lay.name ? ' - breeding with it now, every click goes straight to the plot' :
				(S.mode === 'plant' && S.plantLayout === lay.name
					? ' - Plant mode is growing it, every click reaches the plot on the next step' :
				(typeof lay.recipe === 'string' && !lay.use
					? ' - for ' + recipeBadge(m, lay.recipe) + ', not in use for breeding' : ''))));
		var cols = speciesColors(grid, tiles);
		for (var y = 0; y < 6; y++) {
			for (var x = 0; x < 6; x++) {
				if (!m.isTileUnlocked(x, y)) { html += '<div class="ggCell ggLocked"></div>'; continue; }
				var key = grid[y][x];
				var hook = ' ggEdit" data-act="paint" data-x="' + x + '" data-y="' + y;
				if (!sowable(m, key) || !key) {
					html += '<div class="ggCell ggHole' + hook + '"' + tipText('empty - click to paint') + '></div>';
					continue;
				}
				var p = m.plants[key];
				html += '<div class="ggCell' + hook + '" style="background:' + cols.map[key] +
					';border-color:' + cols.map[key] + ';"' + tipText(p.name +
					(p.unlocked ? '' : ' (not unlocked yet)') + ' - click to paint') + '>' +
					'<div class="ggSeedIcon" style="background-position:0px -' + (p.icon * 48) + 'px;"></div></div>';
			}
		}
		for (var i = 0; i < cols.order.length; i++) {
			var sp = m.plants[cols.order[i]];
			legend += '<div class="ggLegend"><span class="ggSwatch" style="background:' +
				cols.map[cols.order[i]] + ';"></span>' + esc(sp ? sp.name : cols.order[i]) + '</div>';
		}
	} else {
		setText('ggEditTitle', 'Nothing open - pick a layout in the Library, or press New to start one.');
		for (var y = 0; y < 6; y++) {
			for (var x = 0; x < 6; x++) {
				html += '<div class="ggCell' + (m.isTileUnlocked(x, y) ? ' ggHole' : ' ggLocked') + '"></div>';
			}
		}
	}
	setHTML('ggEditGrid', html);
	setHTML('ggEditLegend', legend);
	setHTML('ggPalette', paletteHTML(m));
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

function saveString() {
	// v2: a layout's recipe no longer means it is in use; the flag says so.
	return JSON.stringify({v:2, S:S, stats:stats});
}

function loadString(str) {
	if (!str) return;
	var data = JSON.parse(str);
	if (data.S) for (var k in DEFAULTS) if (typeof data.S[k] === typeof DEFAULTS[k]) S[k] = data.S[k];
	if (data.stats) for (var k in stats) if (typeof data.stats[k] === 'number') stats[k] = data.stats[k];
	// Saves up to 1.3 may carry an 'edits' field: tiles changed by clicking
	// the assistant's preview, which is read-only now. It is not read, so
	// such a save loads as if it had none and the next save drops it. The
	// version stays 2 because nothing that is still read changed shape.
	if (TABS.indexOf(S.tab) < 0) S.tab = DEFAULTS.tab;
	// A save from up to 1.3 may be in Custom mode, which is gone. Off is its
	// heir - the player was planting a drawing of their own, and Off is where
	// the assistant keeps its hands off a plot planted by hand - and so is
	// any other mode name this version does not know.
	if (!isMode(S.mode)) S.mode = 'off';
	// Saves from before the library simply have no layouts. A layout that is
	// not the right shape is dropped whole; which seeds it names is left to
	// sowableCopy, because the garden may not have loaded yet to ask.
	if (data.S && data.S.layouts !== undefined) {
		S.layouts = [];
		var saved = Array.isArray(data.S.layouts) ? data.S.layouts : [];
		// Before v2 a recipe was always in use - it was only ever set by
		// Customize - so a layout the player customized under 1.5 keeps
		// being planted after the update.
		var legacy = !(data.v >= 2);
		for (var i = 0; i < saved.length; i++) {
			var l = saved[i];
			if (!l || typeof l.name !== 'string' || !cleanName(l.name) || !gridShaped(l.grid)) continue;
			var lay = {name: uniqueName(cleanName(l.name)), grid: cloneGrid(l.grid)};
			S.layouts.push(lay);
			// A link that is not text is dropped, not the layout: the drawing
			// is still good as a free layout. So is a flag that is not true.
			if (typeof l.recipe !== 'string') continue;
			linkRecipe(lay, l.recipe);
			if (l.use === true || (legacy && l.use === undefined)) claimRecipe(lay);
		}
	}
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

	// A new soil means the layout on screen was scored for another one, so it
	// is worked out again at once - what the Re-plan button used to be for.
	// Growing plots need no such watch: the tile count is in the plan key.
	var soilChanged = (lastSoil !== null && m.soil !== lastSoil);
	lastSoil = m.soil;
	if (soilChanged) {
		try { rebuildPlan(m, true); } catch (err) { console.error('[Grandpa\'s Greenhouse] re-plan failed:', err); }
	}

	// M.nextStep is the timestamp of the next garden step, so it changing is
	// the one reliable signal that a step just happened.
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
	lastSoil = null;
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
	 * mods and for dev/test.js. Nothing here mutates the garden; setMode,
	 * setTarget and the layout calls only move the same switches the panel
	 * does, through the same functions its clicks call.
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
	getDrops:    function () { var m = garden(); return m ? ensureDrops(m) : null; },
	getRecipe:   function (key) { var m = garden(); return m ? bestRecipeFor(m, key) : null; },
	getPlan:     function () { return plan; },
	getSettings: function () { return S; },
	getStats:    function () { return stats; },
	getStatus:   function () { return statusText; },
	// The hover texts live here rather than in the markup, which only names them.
	getHelp:     function (key) { return HELP[key] || ''; },
	setMode:     function (mode) { S.mode = mode; plan = null; },
	setTarget:   function (key) { S.target = key || ''; plan = null; },
	setObjective:function (key) { S.objective = key; plan = null; },
	replan:      function () { var m = garden(); return m ? rebuildPlan(m, true) : null; },
	wipeData:    function () { wipeData(garden()); },
	getRemovals: function () { var m = garden(); return m ? removalsFor(m) : []; },
	getClearance:function () { return clearanceState(); },
	decide:      function (what) { decideClearance(what); },
	runStepNow:  function () { var m = garden(); if (m) { rebuildPlan(m, false); runStep(m); } },
	setTab:      function (tab) { setTab(tab); },
	getLayouts:  function () { return S.layouts; },
	createLayout:function (name) { return createLayout(name); },
	renameLayout:function (from, to) { return renameLayout(garden(), from, to); },
	duplicateLayout: function (name) { return duplicateLayout(name); },
	deleteLayout:function (name) { return deleteLayout(garden(), name); },
	selectLayout:function (name) { return selectLayout(garden(), name); },
	// The library as listed: stored layouts, then the defaults (virtual), by
	// name and plan key only - no grid, exactly what the list itself needs.
	getLibrary:  function () {
		var m = garden(), out = [];
		for (var i = 0; i < S.layouts.length; i++) {
			var l = {name: S.layouts[i].name, virtual: false};
			if (typeof S.layouts[i].recipe === 'string') l.recipe = S.layouts[i].recipe;
			out.push(l);
		}
		var defs = m ? breedDefaults(m) : [];
		for (var d = 0; d < defs.length; d++) {
			out.push({name: defs[d].name, virtual: true, seed: defs[d].seed, recipe: defs[d].recipe});
		}
		return out;
	},
	// What the editor shows: a stored layout, or a default with its grid
	// worked out (once per plan key) - a copy either way.
	getEditorLayout: function () {
		var m = garden(), def = editorDefault(m), lay = editorLayout();
		if (lay) return {name: lay.name, grid: cloneGrid(lay.grid), virtual: false, recipe: lay.recipe};
		if (!def) return null;
		return {name: def.name, grid: cloneGrid(defaultGrid(m, def.recipe, def.rec)), virtual: true,
			seed: def.seed, recipe: def.recipe};
	},
	cachedDefaults: function () { var n = 0; for (var k in virtGrids) n++; return n; },
	resetToDefault: function (name) { return resetToDefault(garden(), name); },
	setBrush:    function (key) { setBrush(key); },
	// Without a key this paints with the brush, which is exactly what a click does.
	paintTile:   function (x, y, key) {
		var m = garden(); return m ? paintTile(m, x, y, key === undefined ? currentBrush(m) : key) : false;
	},
	exportLayouts: function () { return exportLayouts(); },
	importLayouts: function (text) { return importLayouts(garden(), text); },
	customizeCurrentPlan: function () { return customizeCurrentPlan(garden()); },
	useForBreeding: function (name) { return useForBreeding(garden(), name); },
	stopUsing:   function (name) { return stopUsing(garden(), name); },
	plantLayout: function (name) { return plantThis(garden(), name); },
	stopPlanting:function (name) { return stopPlanting(garden(), name); },
	loadBreedLayout: function (key) { return loadBreedLayout(garden(), key); }
});

})();
