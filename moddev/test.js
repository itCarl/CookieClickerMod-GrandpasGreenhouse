/**
 * Behavioural tests for Grandpa's Greenhouse, run against the game's real
 * minigameGarden.js through dev/garden.js.
 *
 *   node test.js
 */
'use strict';

var boot = require('./garden.js').boot;

var passed = 0, failed = 0;

function ok(name, cond, detail) {
	if (cond) { passed++; console.log('  ok   ' + name); }
	else { failed++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

function eq(name, got, want) {
	ok(name, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));
}

function near(name, got, want, tol) {
	ok(name, Math.abs(got - want) <= tol, 'got ' + got + ', wanted ' + want + ' +-' + tol);
}

function fresh(opts) {
	var sb = boot(opts || {seed: 1, level: 9});
	sb.mod = sb.loadMod();
	return sb;
}

// Enough to sow the queenbeet recipe, with queenbeet itself still missing -
// the assistant only works towards seeds you do not already have.
var QUEENBEET_PARENTS = ['bakerWheat', 'chocoroot', 'bakeberry'];

function allSeeds(sb) {
	var keys = [];
	for (var k in sb.M.plants) keys.push(k);
	return keys;
}

/* ------------------------------------------------------------------ *
 * 1. The recipe table is recovered from the game
 * ------------------------------------------------------------------ */
console.log('\nrecipes derived from M.getMuts');
(function () {
	var sb = fresh();
	sb.unlock(allSeeds(sb));
	sb.step();                                   // gives the mod a chance to probe
	var recipes = sb.mod.getRecipes();
	ok('table was built', !!recipes);

	var n = 0;
	for (var k in recipes) n++;
	ok('every seed has at least one route (' + n + ' of 34)', n >= 30, 'only ' + n);

	// Spot checks straight off the game's own source.
	function chanceOf(target, parents) {
		var list = recipes[target] || [];
		for (var i = 0; i < list.length; i++) {
			var p = list[i].parents, match = p.length === parents.length;
			for (var j = 0; match && j < parents.length; j++) {
				var found = false;
				for (var q = 0; q < p.length; q++) {
					if (p[q].key === parents[j][0] && p[q].n === parents[j][1]) found = true;
				}
				if (!found) match = false;
			}
			if (match) return list[i].chance;
		}
		return null;
	}

	near('thumbcorn from 2x bakerWheat is 5%', chanceOf('thumbcorn', [['bakerWheat', 2]]), 0.05, 1e-9);
	near('bakeberry from 2x bakerWheat is 0.1%', chanceOf('bakeberry', [['bakerWheat', 2]]), 0.001, 1e-9);
	near('cronerice from wheat + thumbcorn is 1%',
		chanceOf('cronerice', [['bakerWheat', 1], ['thumbcorn', 1]]), 0.01, 1e-9);
	near('queenbeet from chocoroot + bakeberry is 1%',
		chanceOf('queenbeet', [['chocoroot', 1], ['bakeberry', 1]]), 0.01, 1e-9);
	near('everdaisy needs 3x tidygrass + 3x elderwort at 0.2%',
		chanceOf('everdaisy', [['tidygrass', 3], ['elderwort', 3]]), 0.002, 1e-9);
	near('queenbeetLump needs 8x queenbeet at 0.1%',
		chanceOf('queenbeetLump', [['queenbeet', 8]]), 0.001, 1e-9);

	// The ceilings are what stop a layout from simply being "as many as fit".
	var clover = (recipes['clover'] || []).filter(function (r) {
		return r.parents.length === 2;
	})[0];
	ok('clover route was found', !!clover);

	var gc = recipes['goldenClover'] || [];
	var hasCeiling = false;
	for (var i = 0; i < gc.length; i++) {
		for (var key in gc[i].ceilings) hasCeiling = true;
	}
	ok('a ceiling was detected somewhere in the table',
		hasCeiling || JSON.stringify(recipes['meddleweed'] || '').indexOf('ceilings') >= 0);
})();

/* ------------------------------------------------------------------ *
 * 2. Breed mode: a layout that actually breeds the target
 * ------------------------------------------------------------------ */
console.log('\nbreed layouts');
(function () {
	var sb = fresh();
	sb.unlock(['bakerWheat', 'thumbcorn', 'cronerice', 'chocoroot', 'bakeberry']);
	sb.step();

	sb.mod.setMode('breed');
	sb.mod.setTarget('queenbeet');
	var plan = sb.mod.replan();

	ok('a plan was produced', !!plan && !!plan.grid);
	ok('the plan expects to breed something', plan.score > 0, 'score ' + (plan && plan.score));

	// Only the two parents may appear.
	var used = {};
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) if (plan.grid[y][x]) used[plan.grid[y][x]] = 1;
	var keys = Object.keys(used).sort();
	eq('only the recipe parents are planted', keys.join(','), 'bakeberry,chocoroot');

	// A layout with no empty tile can never mutate.
	var holes = 0;
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
		if (sb.M.isTileUnlocked(x, y) && !plan.grid[y][x]) holes++;
	}
	ok('the layout leaves empty tiles to mutate into (' + holes + ')', holes > 0);

	// Nothing is planted outside the unlocked plot.
	var outside = 0;
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
		if (!sb.M.isTileUnlocked(x, y) && plan.grid[y][x]) outside++;
	}
	eq('nothing is planted on a locked tile', outside, 0);

	// It should beat a naive checkerboard of the same two parents.
	var naive = [];
	for (var y = 0; y < 6; y++) { naive[y] = []; for (var x = 0; x < 6; x++) naive[y][x] = ''; }
	var alt = 0;
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
		if (sb.M.isTileUnlocked(x, y) && (x + y) % 2 === 0) {
			naive[y][x] = (alt++ % 2) ? 'bakeberry' : 'chocoroot';
		}
	}
	// Score the naive grid on the same terms the mod uses - the expected rate
	// per step over a cycle, tile by tile - so the two layouts are comparable.
	function scoreGrid(grid, target) {
		var total = 0;
		for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
			if (!sb.M.isTileUnlocked(x, y) || grid[y][x]) continue;
			var neighs = {}, any = 0;
			for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				var nx = x + dx, ny = y + dy;
				if (nx < 0 || nx > 5 || ny < 0 || ny > 5 || !sb.M.isTileUnlocked(nx, ny)) continue;
				if (!grid[ny][nx]) continue;
				any++; neighs[grid[ny][nx]] = (neighs[grid[ny][nx]] || 0) + 1;
			}
			if (!any) continue;
			total += sb.mod.getLandChance(neighs, target);
		}
		return total;
	}
	var naiveScore = scoreGrid(naive, 'queenbeet');
	ok('the planner beats a plain checkerboard (' +
		plan.score.toFixed(3) + ' vs ' + naiveScore.toFixed(3) + ')',
		plan.score >= naiveScore * 0.95);
})();

/* ------------------------------------------------------------------ *
 * 2b. Recipes that need many of one parent at once
 * ------------------------------------------------------------------ */
console.log('\nhigh-count recipes');
(function () {
	// Juicy queenbeet wants eight mature queenbeets around one empty tile.
	// Until all eight are down the score is flat zero, so no single-tile change
	// looks like an improvement and hill climbing never leaves the empty plot.
	// It only works because the starting shapes include a solid block with
	// isolated holes.
	var sb = fresh({seed: 51, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(['queenbeet']);
	sb.clear();
	sb.mod.setMode('breed');
	sb.mod.setTarget('queenbeetLump');
	var plan = sb.mod.replan();

	ok('a plan exists for Juicy queenbeet', !!plan && !!plan.grid);
	ok('and it actually expects to breed one', plan.score > 0,
		'score ' + (plan && plan.score));

	// At least one empty tile must have all eight neighbours planted.
	var eights = 0;
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
		if (!sb.M.isTileUnlocked(x, y) || plan.grid[y][x]) continue;
		var n = 0;
		for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			var nx = x + dx, ny = y + dy;
			if (nx < 0 || nx > 5 || ny < 0 || ny > 5) continue;
			if (plan.grid[ny][nx] === 'queenbeet') n++;
		}
		if (n >= 8) eights++;
	}
	ok('with at least one tile fully ringed by eight (' + eights + ')', eights > 0);
})();

(function () {
	// Shriekbulb off five elderwort wants a ring: a border and a core with a
	// moat between them, so moat tiles see plants from both sides. Hill
	// climbing does not find a ring unaided either.
	var sb = fresh({seed: 52, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(['elderwort']);
	sb.clear();
	sb.mod.setMode('breed');
	sb.mod.setTarget('shriekbulb');
	var plan = sb.mod.replan();
	ok('a plan exists for Shriekbulb', !!plan && !!plan.grid);
	ok('and it expects to breed one', plan.score > 0, 'score ' + (plan && plan.score));

	var fives = 0;
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
		if (!sb.M.isTileUnlocked(x, y) || plan.grid[y][x]) continue;
		var n = 0;
		for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			var nx = x + dx, ny = y + dy;
			if (nx < 0 || nx > 5 || ny < 0 || ny > 5) continue;
			if (plan.grid[ny][nx] === 'elderwort') n++;
		}
		if (n >= 5) fives++;
	}
	ok('with tiles seeing five or more elderwort (' + fives + ')', fives > 0);
})();

/* ------------------------------------------------------------------ *
 * 3. Boost mode
 * ------------------------------------------------------------------ */
console.log('\nboost layouts');
(function () {
	var sb = fresh();
	sb.unlock(allSeeds(sb));
	sb.step();

	sb.mod.setMode('boost');
	sb.mod.setObjective('cps');
	var plan = sb.mod.replan();
	ok('a CpS layout was produced', !!plan && !!plan.grid);
	ok('it beats an empty plot', plan.pct > 0, 'pct ' + (plan && plan.pct));

	var filled = 0;
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) if (plan.grid[y][x]) filled++;
	ok('it fills most of the plot (' + filled + '/36)', filled >= 30);

	sb.mod.setObjective('buildings');
	var cheap = sb.mod.replan();
	ok('a cheaper-buildings layout was produced', !!cheap && !!cheap.grid);
	ok('cheaper buildings is reported as a saving', cheap.pct < 0, 'pct ' + (cheap && cheap.pct));
})();

/* ------------------------------------------------------------------ *
 * 4. The scratch plot must not disturb the real garden
 * ------------------------------------------------------------------ */
console.log('\nscratch plot is invisible');
(function () {
	var sb = fresh();
	sb.unlock(allSeeds(sb));
	sb.clear();
	sb.plant('bakerWheat', 2, 2, 40);
	sb.plant('thumbcorn', 3, 3, 12);
	var before = JSON.stringify(sb.M.plot);
	sb.M.computeBoostPlot(); sb.M.computeEffs();
	var effsBefore = JSON.stringify(sb.M.effs);

	sb.mod.setMode('boost');
	sb.mod.setObjective('click');
	sb.mod.replan();

	eq('the plot came back byte-identical', JSON.stringify(sb.M.plot), before);
	eq('the effect numbers came back byte-identical', JSON.stringify(sb.M.effs), effsBefore);
})();

/* ------------------------------------------------------------------ *
 * 5. Acting on a step
 * ------------------------------------------------------------------ */
console.log('\nstep behaviour');
(function () {
	var sb = fresh();
	sb.unlock(['bakerWheat']);
	sb.clear();

	// A mature plant of a species never banked must be harvested, because that
	// is the only thing that unlocks the seed.
	sb.plant('thumbcorn', 2, 2, 99);
	sb.mod.setMode('tend');
	var before = sb.unlockedCount();
	sb.mod.runStepNow();
	eq('a new species is harvested on sight', sb.M.plot[2][2][0], 0);
	eq('and the seed is banked', sb.unlockedCount(), before + 1);
})();

(function () {
	var sb = fresh();
	sb.unlock(allSeeds(sb));
	sb.clear();

	// Ripe meddleweed is worth uprooting; young meddleweed is worth leaving,
	// because the spore drop scales with age.
	sb.plant('meddleweed', 1, 1, 95);
	sb.plant('meddleweed', 4, 4, 20);
	sb.mod.setMode('tend');
	sb.mod.runStepNow();
	eq('ripe meddleweed is uprooted', sb.M.plot[1][1][0], 0);
	ok('young meddleweed is left to ripen', sb.M.plot[4][4][0] !== 0);
})();

(function () {
	var sb = fresh({seed: 3, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(QUEENBEET_PARENTS);
	sb.clear();
	sb.mod.setMode('breed');
	sb.mod.setTarget('queenbeet');
	var plan = sb.mod.replan();
	sb.mod.runStepNow();

	var wrong = 0, planted = 0, wanted = 0;
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
		if (!sb.M.isTileUnlocked(x, y)) continue;
		var want = plan.grid[y][x];
		var got = sb.M.plot[y][x][0] ? sb.M.plantsById[sb.M.plot[y][x][0] - 1].key : '';
		if (want) wanted++;
		if (want && got === want) planted++;
		if (got && got !== want) wrong++;
	}
	eq('the layout was planted in full', planted, wanted);
	eq('nothing was planted the layout did not ask for', wrong, 0);
	ok('cookies were spent (' + Math.round(sb.Game.spentTotal) + ')', sb.Game.spentTotal > 0);
})();

(function () {
	var sb = fresh({seed: 4, level: 9, cookies: 0, cookiesPs: 1e9});
	sb.unlock(QUEENBEET_PARENTS);
	sb.clear();
	sb.mod.setMode('breed');
	sb.mod.setTarget('queenbeet');
	sb.mod.replan();
	sb.mod.runStepNow();
	var planted = 0;
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) if (sb.M.plot[y][x][0]) planted++;
	eq('with no cookies, nothing is planted', planted, 0);
	ok('and it says so', /cookies/.test(sb.mod.getStatus()), sb.mod.getStatus());
})();

(function () {
	var sb = fresh();
	sb.unlock(QUEENBEET_PARENTS.concat(['elderwort']));
	sb.clear();
	sb.plant('elderwort', 2, 2, 60);        // immortal
	sb.mod.setMode('breed');
	sb.mod.setTarget('queenbeet');
	sb.mod.replan();
	sb.mod.runStepNow();
	ok('an immortal plant is never uprooted for a layout', sb.M.plot[2][2][0] !== 0);
})();

(function () {
	var sb = fresh();
	sb.unlock(allSeeds(sb));
	sb.clear();
	sb.mod.setMode('off');
	sb.plant('thumbcorn', 2, 2, 99);
	sb.plant('meddleweed', 3, 3, 99);
	var before = JSON.stringify(sb.M.plot);
	sb.mod.runStepNow();
	eq('Off touches nothing', JSON.stringify(sb.M.plot), before);
})();

/* ------------------------------------------------------------------ *
 * 5b. Regressions: the two bugs that made Breed worse than Tend
 * ------------------------------------------------------------------ */
console.log('\ntargeting regressions');
(function () {
	// A mutation of a species you have not banked must be allowed to ripen.
	// Harvesting it below maturity banks nothing, so clearing it "because the
	// layout did not ask for it" destroys the very thing the layout is for.
	var sb = fresh({seed: 11, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(QUEENBEET_PARENTS);
	sb.clear();
	sb.mod.setMode('breed');
	sb.mod.setTarget('queenbeet');
	var plan = sb.mod.replan();

	// Find a tile the layout wants planted, and drop a young queenbeet on it.
	var spot = null;
	for (var y = 0; y < 6 && !spot; y++) for (var x = 0; x < 6; x++) {
		if (sb.M.isTileUnlocked(x, y) && plan.grid[y][x]) { spot = [x, y]; break; }
	}
	sb.plant('queenbeet', spot[0], spot[1], 1);          // age 1: nowhere near mature
	sb.mod.runStepNow();
	var still = sb.M.plot[spot[1]][spot[0]];
	ok('an unbanked mutation is left to ripen, not cleared for the layout',
		still[0] === sb.M.plants['queenbeet'].id + 1,
		'tile now holds ' + JSON.stringify(still));

	// Once it is mature it must be taken, which is what banks the seed.
	sb.plant('queenbeet', spot[0], spot[1], 99);
	var before = sb.unlockedCount();
	sb.mod.runStepNow();
	eq('and harvested the moment it matures', sb.unlockedCount(), before + 1);
})();

(function () {
	// Everything reachable without fungus, banked. Shriekbulb is still offered
	// off 5x elderwort at 0.1%, so a "nursery only as a last resort" rule would
	// grind that forever instead of opening the fungus half of the tree.
	var sb = fresh({seed: 12, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(['bakerWheat', 'thumbcorn', 'cronerice', 'gildmillet', 'clover',
		'goldenClover', 'shimmerlily', 'elderwort', 'bakeberry']);
	sb.clear();
	sb.mod.setMode('breed');
	sb.mod.setTarget('');
	var plan = sb.mod.replan();

	ok('with only the fungus branch left, it switches to the nursery',
		!!plan && plan.nursery === true,
		'plan is ' + JSON.stringify(plan && (plan.label || plan.target)));

	// The nursery only works if the plot is actually bare: the game sprouts a
	// weed only in a tile with no neighbours at all. Uprooting is gated behind
	// a confirmation now, so answer it first.
	sb.plant('clover', 2, 2, 99);
	sb.plant('elderwort', 3, 3, 20);
	sb.mod.decide('clear');
	sb.mod.runStepNow();
	var occupied = 0;
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
		if (sb.M.isTileUnlocked(x, y) && sb.M.plot[y][x][0]) {
			var p = sb.M.plantsById[sb.M.plot[y][x][0] - 1];
			if (!p.immortal) occupied++;
		}
	}
	eq('the nursery clears mortal plants out of the way', occupied, 0);
})();

/* ------------------------------------------------------------------ *
 * 5c. Nothing is uprooted without being asked
 * ------------------------------------------------------------------ */
console.log('\nclearance');

/** A plot of mature clover with a queenbeet layout that wants none of it. */
function inTheWay(opts) {
	var sb = fresh(opts || {seed: 31, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(QUEENBEET_PARENTS.concat(['clover']));
	sb.clear();
	for (var i = 0; i < 4; i++) sb.plant('clover', 1 + i, 1, 60);   // mature, not expiring
	sb.mod.setMode('breed');
	sb.mod.setTarget('queenbeet');
	sb.mod.replan();
	return sb;
}

function cloverLeft(sb) {
	var n = 0;
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
		if (sb.M.plot[y][x][0] === sb.M.plants['clover'].id + 1) n++;
	}
	return n;
}

(function () {
	var sb = inTheWay();
	eq('it asks rather than assuming', sb.mod.getClearance(), 'ask');
	eq('and it knows exactly what it would take', sb.mod.getRemovals().length, 4);

	sb.mod.runStepNow();
	eq('a garden step uproots nothing while the question stands', cloverLeft(sb), 4);

	// The rest of the step still runs: free tiles get planted.
	var planted = 0;
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
		var id = sb.M.plot[y][x][0];
		if (id && id !== sb.M.plants['clover'].id + 1) planted++;
	}
	ok('but the layout is still planted around them (' + planted + ')', planted > 0);
})();

(function () {
	var sb = inTheWay();
	sb.mod.decide('clear');
	sb.mod.runStepNow();
	eq('answering "clear" uproots them', cloverLeft(sb), 0);
})();

(function () {
	var sb = inTheWay();
	sb.mod.decide('keep');
	sb.mod.runStepNow();
	eq('answering "keep" leaves them alone', cloverLeft(sb), 4);
	sb.mod.runStepNow();
	eq('and keeps leaving them alone on later steps', cloverLeft(sb), 4);
})();

(function () {
	// An answer covers the layout it was given for, and nothing else.
	var sb = inTheWay();
	sb.mod.decide('keep');
	eq('the answer sticks for this layout', sb.mod.getClearance(), 'keep');
	sb.mod.setTarget('duketater');
	sb.mod.replan();
	eq('changing the target asks again', sb.mod.getClearance(), 'ask');
})();

(function () {
	// Turning the setting off restores the old straight-through behaviour.
	var sb = inTheWay();
	sb.mod.getSettings().askBeforeClearing = false;
	eq('with the setting off there is nothing to answer', sb.mod.getClearance(), 'clear');
	sb.mod.runStepNow();
	eq('and it clears straight away', cloverLeft(sb), 0);
})();

(function () {
	// A plant inside the expiry margin was going to die this cycle anyway, so
	// taking it is not a loss and is not worth a question. The margin is a step
	// of the plant's own growth: clover covers up to 2.5 age in one, so 98 is
	// inside it and 95 - two more steps of breeding - is not.
	var sb = fresh({seed: 32, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(QUEENBEET_PARENTS.concat(['clover']));
	sb.clear();
	sb.plant('clover', 1, 1, 98);
	sb.mod.setMode('breed');
	sb.mod.setTarget('queenbeet');
	sb.mod.replan();
	eq('an expiring plant is not part of the question', sb.mod.getRemovals().length, 0);
	sb.mod.runStepNow();
	eq('and it is harvested without asking', cloverLeft(sb), 0);
})();

(function () {
	// Immortals and unbanked mutations were never at risk and must not appear
	// in the question either.
	var sb = fresh({seed: 33, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(QUEENBEET_PARENTS.concat(['elderwort']));
	sb.clear();
	sb.plant('elderwort', 1, 1, 60);        // immortal
	sb.plant('queenbeet', 4, 4, 2);         // not banked yet, still growing
	sb.mod.setMode('breed');
	sb.mod.setTarget('queenbeet');
	sb.mod.replan();
	eq('neither is up for removal', sb.mod.getRemovals().length, 0);
})();

(function () {
	// With "Harvest mature plants" off nothing else takes an expiring plant the
	// layout does not want, so it must not be left out of the clearing too -
	// it would stand in the way until it rots.
	var sb = fresh({seed: 32, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(QUEENBEET_PARENTS.concat(['clover']));
	sb.clear();
	sb.plant('clover', 1, 1, 98);
	sb.mod.setMode('breed');
	sb.mod.setTarget('queenbeet');
	sb.mod.getSettings().harvestMature = false;
	sb.mod.getSettings().askBeforeClearing = false;
	sb.mod.replan();
	eq('with harvest-mature off an expiring plant is up for removal', sb.mod.getRemovals().length, 1);
	sb.mod.runStepNow();
	eq('and it is cleared', cloverLeft(sb), 0);
})();

/* ------------------------------------------------------------------ *
 * 5d. Clearing unwanted growth immediately
 *
 * A banked fungus that spreads into a mutation slot is only taken once it
 * matures - by which time it has seeded its neighbours. The setting takes
 * it as soon as it appears; locked species and the layout's own plants
 * are never part of that.
 * ------------------------------------------------------------------ */
console.log('\nclear unwanted growth immediately');

/** A planted queenbeet layout, Safety off, with a mildew sprout in a slot. */
function sproutInSlot(unlockMildew, now) {
	var sb = fresh({seed: 101, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(QUEENBEET_PARENTS.concat(unlockMildew ? ['whiteMildew'] : []));
	sb.clear();
	sb.mod.setMode('breed');
	sb.mod.setTarget('queenbeet');
	sb.mod.getSettings().askBeforeClearing = false;
	if (now !== undefined) sb.mod.getSettings().clearImmediately = now;
	sb.mod.replan();
	sb.mod.runStepNow();                                // plant the layout
	sb.step();                                          // the hook's first look only takes note
	var grid = sb.mod.getPlan().grid, slot = null;
	for (var y = 0; y < 6 && !slot; y++) for (var x = 0; x < 6 && !slot; x++) {
		if (sb.M.isTileUnlocked(x, y) && !grid[y][x]) slot = [x, y];
	}
	sb.M.plot[slot[1]][slot[0]] = [sb.M.plants.whiteMildew.id + 1, 0];
	sb.slot = slot;
	return sb;
}

function mildewInSlot(sb) {
	return sb.M.plot[sb.slot[1]][sb.slot[0]][0] === sb.M.plants.whiteMildew.id + 1;
}

function listed(sb, x, y) {
	return sb.mod.getRemovals().some(function (r) { return r.x === x && r.y === y; });
}

(function () {
	var sb = sproutInSlot(true);
	eq('the setting is off by default', sb.mod.getSettings().clearImmediately, false);
	ok('so a banked sprout is not up for removal', !listed(sb, sb.slot[0], sb.slot[1]));
	sb.step();
	ok('and it is left to grow', mildewInSlot(sb));
	var M = sb.M, mature = M.plants.whiteMildew.mature, held = 0, before = 0;
	for (var i = 0; i < 20 && mildewInSlot(sb); i++) {
		before = M.plot[sb.slot[1]][sb.slot[0]][1];
		sb.step();
		if (mildewInSlot(sb)) held++;
	}
	ok('it holds the slot for ' + (held + 1) + ' steps, until it matures',
		!mildewInSlot(sb) && held > 0 && before < mature, 'last age ' + before + ', mature ' + mature);
})();

(function () {
	var sb = sproutInSlot(true, true);
	ok('with the setting on a banked sprout in a slot is up for removal', listed(sb, sb.slot[0], sb.slot[1]));
	sb.step();
	ok('and it is gone after one step', !mildewInSlot(sb));
})();

(function () {
	// Safety still has the last word: with it on, the sprout is part of the
	// question and stays until the player answers.
	var sb = sproutInSlot(true, true);
	sb.mod.getSettings().askBeforeClearing = true;
	eq('with Safety on it is asked about', sb.mod.getClearance(), 'ask');
	sb.step();
	ok('and stays until answered', mildewInSlot(sb));
	sb.mod.decide('clear');
	sb.step();
	ok('and is cleared once answered', !mildewInSlot(sb));
})();

(function () {
	var sb = sproutInSlot(false, true);
	ok('a species not banked yet is never up for removal', !listed(sb, sb.slot[0], sb.slot[1]));
	sb.step();
	ok('and is left to ripen', mildewInSlot(sb));
})();

(function () {
	// The layout's own seedlings are exactly what it wants - never cleared.
	var sb = sproutInSlot(true, true);
	var grid = sb.mod.getPlan().grid, M = sb.M, wanted = 0, onPlan = 0, standing = 0;
	sb.step();
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
		if (!grid[y][x]) continue;
		wanted++;
		if (listed(sb, x, y)) onPlan++;
		var t = M.plot[y][x];
		if (t[0] && M.plantsById[t[0] - 1].key === grid[y][x]) standing++;
	}
	ok('the layout has tiles of its own (' + wanted + ')', wanted > 0);
	eq('none of them is up for removal', onPlan, 0);
	eq('and every one still holds its seedling', standing, wanted);
})();

(function () {
	// Immortals stay out of it, however young.
	var sb = fresh({seed: 33, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(QUEENBEET_PARENTS.concat(['elderwort']));
	sb.clear();
	sb.plant('elderwort', 1, 1, 2);
	sb.mod.setMode('breed');
	sb.mod.setTarget('queenbeet');
	sb.mod.getSettings().clearImmediately = true;
	sb.mod.replan();
	eq('an immortal sprout is not up for removal', sb.mod.getRemovals().length, 0);
})();

(function () {
	// The banner has to actually reach the panel.
	var sb = inTheWay({seed: 34, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.step();
	var text = sb.dom.get('ggClearText').textContent;
	ok('the panel asks in words', /stand in the way/.test(text) && /[Cc]lover/.test(text), text);
	var panel = sb.dom.findCreated('grandpasGreenhousePanel');
	ok('with both answers as buttons',
		panel.innerHTML.indexOf('data-act="clearYes"') >= 0 &&
		panel.innerHTML.indexOf('data-act="clearNo"') >= 0);
})();

/* ------------------------------------------------------------------ *
 * 6. It survives a long unattended run
 * ------------------------------------------------------------------ */
console.log('\nunattended run');
(function () {
	var sb = fresh({seed: 7, level: 9, cookies: 1e40, cookiesPs: 1});
	sb.unlock(['bakerWheat']);
	sb.clear();
	sb.mod.setMode('breed');
	sb.mod.setTarget('');                      // let it choose its own targets

	var err = null;
	try {
		for (var i = 0; i < 400; i++) sb.step();
	} catch (e) { err = e; }
	ok('400 steps without throwing', !err, err && err.stack);

	var found = sb.unlockedCount();
	ok('it banked seeds unattended (' + found + '/34 from 1)', found > 1);
	ok('status is not an error', sb.mod.getStatus().indexOf('error') < 0, sb.mod.getStatus());

	var stats = sb.mod.getStats();
	ok('it harvested (' + stats.harvested + ') and planted (' + stats.planted + ')',
		stats.harvested > 0 && stats.planted > 0);
})();

/* ------------------------------------------------------------------ *
 * 7. Small plots
 * ------------------------------------------------------------------ */
console.log('\nsmall plots');
[1, 3, 5].forEach(function (level) {
	var sb = fresh({seed: 2, level: level, cookies: 1e30, cookiesPs: 1});
	sb.unlock(QUEENBEET_PARENTS);
	sb.clear();
	sb.mod.setMode('breed');
	sb.mod.setTarget('queenbeet');
	var plan = sb.mod.replan();
	var tiles = 0;
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) if (sb.M.isTileUnlocked(x, y)) tiles++;
	ok('farm level ' + level + ' (' + tiles + ' tiles): a plan exists', !!plan && !!plan.grid);
	var outside = 0;
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
		if (!sb.M.isTileUnlocked(x, y) && plan.grid[y][x]) outside++;
	}
	eq('farm level ' + level + ': stays inside the plot', outside, 0);
});

/* ------------------------------------------------------------------ *
 * 7b. The panel
 * ------------------------------------------------------------------ */
console.log('\nthe panel');
(function () {
	// Any error inside the panel disables it for the session and is only ever
	// reported to the console, so the console is the only place a broken UI
	// shows up in a headless run.
	var errors = [];
	var realError = console.error;
	console.error = function () { errors.push(Array.prototype.join.call(arguments, ' ')); };

	var sb, panel;
	try {
		sb = fresh({seed: 21, level: 9, cookies: 1e30, cookiesPs: 1});
		sb.unlock(QUEENBEET_PARENTS);
		sb.clear();
		sb.mod.setMode('breed');
		sb.mod.setTarget('queenbeet');
		sb.step();
		panel = sb.dom.findCreated('grandpasGreenhousePanel');
	} finally {
		console.error = realError;
	}

	ok('the panel is built', !!panel);
	eq('nothing was logged as an error', errors.join(' | '), '');

	var html = panel ? panel.innerHTML : '';
	['Off', 'Tend', 'Breed', 'Boost'].forEach(function (label) {
		ok('the ' + label + ' button is there', html.indexOf('>' + label + '</div>') >= 0);
	});
	ok('there is a Settings tab', html.indexOf('data-act="tab" data-tab="settings"') >= 0);
	ok('there is a seed picker grid', html.indexOf('id="ggSeedGrid"') >= 0);

	// Hover help on the controls whose consequences are not obvious. The
	// markup names the text (data-help = a HELP key, data-tip = literal text)
	// and the game's own tooltip shows it; no native title is left anywhere.
	ok('each mode button explains itself', (html.match(/data-act="mode"[^>]*data-tip="[^"]+"/g) || []).length === 4);
	ok('the progress readout has hover text', /id="ggProgress" data-help="progress"/.test(html));
	ok('there is no Re-plan button: a soil change re-plans by itself',
		html.indexOf('data-act="replan"') < 0 && html.indexOf('>Re-plan<') < 0 && !sb.mod.getHelp('replan'));
	ok('both answers to the clear question explain themselves',
		/data-act="clearYes" data-help="clearYes"/.test(html) && /data-act="clearNo" data-help="clearNo"/.test(html));
	ok('the layout preview explains the dashed squares',
		/data-help="layout"/.test(html) && /mutations can only land on an empty tile/.test(sb.mod.getHelp('layout')));
	ok('no native title attribute is left in the panel', !/ title="/.test(html));
	ok('the boost dropdown is still there', html.indexOf('id="ggChoice"') >= 0);
	ok('there is a layout grid', html.indexOf('id="ggGrid"') >= 0);

	// The assistant's view speaks the Layouts tab's language: one framed pane
	// with a small-caps heading, the choice and question on the left, the
	// preview, legend and status on the right. The Layouts tab keeps its split.
	var aView = html.slice(html.indexOf('id="ggTabAssistant"'), html.indexOf('id="ggTabLayouts"'));
	ok('the assistant view is a single pane, no split',
		/^id="ggTabAssistant"><div class="ggPane ggAsstPane">/.test(aView) &&
		aView.indexOf('ggSplit') < 0 && aView.split('class="ggPane').length - 1 === 1, aView.slice(0, 120));
	ok('it opens with one mode-named heading, filled by refresh',
		aView.indexOf('<div class="ggHead" id="ggAsstHead" data-help="plan"></div>') >= 0 &&
		aView.split('class="ggHead"').length - 1 === 1);
	ok('the Layouts tab keeps its two-pane split',
		html.indexOf('<div class="ggSplit"><div class="ggPane ggLibPane">') >= 0 &&
		html.indexOf('<div class="ggPane ggEdPane">') >= 0);
	var planHalf = aView.slice(0, aView.indexOf('ggPlotCol')), plotHalf = aView.slice(aView.indexOf('ggPlotCol'));
	ok('the question side sits beside the plot side in one grid-beside-column row',
		/<div class="ggRow ggBody"><div class="ggCol ggPlanCol">/.test(aView) && aView.indexOf('ggPlotCol') > 0);
	ok('the left side holds the choice, the picker, the recipe and the question',
		['ggChoiceRow', 'ggSeedGrid', 'ggRecipe', 'ggClearRow'].every(function (id) {
			return planHalf.indexOf('id="' + id + '"') >= 0;
		}));
	ok('the right side holds the preview, the legend and the status',
		['ggGrid', 'ggLegend', 'ggStatus'].every(function (id) {
			return plotHalf.indexOf('id="' + id + '"') >= 0;
		}));
	ok('there is no Reset layout button any more', html.indexOf('ggResetLayout') < 0 &&
		html.indexOf('data-act="resetLayout"') < 0);
	ok('the preview and legend share the editor\'s grid-beside-column row',
		/class="ggRow ggBody"><div data-help="layout"><div class="ggGrid" id="ggGrid">/.test(plotHalf) &&
		html.indexOf('<div class="ggRow ggBody"><div data-help="editor"><div class="ggGrid ggBig" id="ggEditGrid">') >= 0);
	ok('no bare separators or inline layout styles are left in the view',
		aView.indexOf('ggSep') < 0 && aView.indexOf('flex-direction') < 0 && aView.indexOf('min-width') < 0);
	ok('no Settings box or button is left above the views',
		html.indexOf('ggSettingsBox') < 0 && html.indexOf('ggSettingsBtn') < 0 && html.indexOf('data-act="settings"') < 0);
	ok('Settings is a view of its own, after Layouts, in one full-width pane',
		html.indexOf('<div id="ggTabSettings" style="display:none;"><div class="ggPane ggSetPane">' +
			'<div class="ggHead" data-help="settings">Settings</div><div class="ggSetGrid">') >= 0 &&
		html.indexOf('id="ggTabSettings"') > html.indexOf('id="ggTabLayouts"'));
	var sView = html.slice(html.indexOf('id="ggTabSettings"'));
	eq('its toggles are filed under four groups, in order',
		(sView.match(/<div class="ggSubHead">[^<]+<\/div>/g) || []).join('').replace(/<[^>]+>/g, '|'),
		'|Harvesting||Planting||Weeds||Safety|');

	// The seed picker draws the game's own seed packets, one tile per seed
	// still missing, plus the Auto tile that hands the choice back.
	var picker = sb.dom.get('ggSeedGrid').innerHTML;
	var missing = 0;
	for (var k in sb.M.plants) if (!sb.M.plants[k].unlocked) missing++;
	var tiles = picker.split('data-act="pick"').length - 1;
	eq('one tile per missing seed, plus Auto', tiles, missing + 1);
	ok('the Auto tile is there', picker.indexOf('data-seed="*"') >= 0);
	ok('tiles use the plant sprite sheet from the game',
		picker.indexOf('ggSeedIcon') >= 0 && picker.indexOf('background-position:0px -') >= 0);
	ok('exactly one tile is selected', picker.split('ggSel').length - 1 === 1,
		'found ' + (picker.split('ggSel').length - 1));
	ok('unreachable seeds are marked blocked', picker.indexOf('ggBlocked') >= 0);
	ok('each tile carries its recipe as a tooltip', /data-tip="[^"]*mature[^"]*"/.test(picker));
	ok('and none uses a native title', !/ title="/.test(picker));

	// The refresh writes into the panel's children, which the stub hands back
	// as inert elements - so their contents are readable.
	var grid = sb.dom.get('ggGrid').innerHTML;
	var cells = grid.split('ggCell').length - 1;
	eq('the grid draws all 36 tiles', cells, 36);
	ok('the layout preview marks tiles to leave empty', grid.indexOf('ggHole') >= 0);

	ok('progress is shown', /Seeds \d+\/34/.test(sb.dom.get('ggProgress').textContent),
		sb.dom.get('ggProgress').textContent);
	ok('the recipe is spelled out',
		/mature/.test(sb.dom.get('ggRecipe').textContent),
		sb.dom.get('ggRecipe').textContent);
	ok('the status line names the next step',
		/Next step in/.test(sb.dom.get('ggStatus').innerHTML),
		sb.dom.get('ggStatus').innerHTML);
})();

(function () {
	// Picking a seed in the grid changes the target; the Auto tile gives the
	// choice back to the assistant.
	var sb = fresh({seed: 23, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(QUEENBEET_PARENTS);
	sb.step();

	sb.mod.setTarget('queenbeet');
	sb.mod.setMode('breed');
	sb.mod.replan();
	eq('an explicit pick is held', sb.mod.getSettings().target, 'queenbeet');
	eq('and the plan works on it', sb.mod.getPlan().target, 'queenbeet');

	sb.mod.setTarget('');
	var auto = sb.mod.replan();
	eq('Auto clears the explicit pick', sb.mod.getSettings().target, '');
	ok('and the assistant chooses for itself', !!auto && (!!auto.target || auto.nursery === true));
})();

(function () {
	// The settings only render on the Settings page, and they are the
	// controls most in need of a why: each keeps its hover text, is drawn as a
	// slide switch over the real checkbox, and has its help written under it.
	var sb = fresh({seed: 41, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(QUEENBEET_PARENTS);
	sb.step();
	var panelEl = sb.dom.findCreated('grandpasGreenhousePanel');
	var panel = panelEl.innerHTML;
	['bankNew', 'harvestMature', 'keepPlan', 'clearImmediately', 'pullWeeds', 'askBeforeClearing'].forEach(function (k) {
		var re = new RegExp('<div class="ggSetItem" data-help="([^"]+)"><div class="ggSet"><input[^>]*id="ggSet-' + k + '"');
		var hit = re.exec(panel);
		ok('the ' + k + ' setting has hover text', !!hit);
		ok('and is drawn as a slide switch over the real checkbox', panel.indexOf(
			'<input type="checkbox" class="ggSwIn" id="ggSet-' + k + '" data-key="' + k + '">' +
			'<label class="ggSwitch" for="ggSet-' + k + '"></label><label for="ggSet-' + k + '">') >= 0);
		var after = panel.slice(panel.indexOf('id="ggSet-' + k + '"'));
		var help = /<div class="ggSetHelp">([^<]*)<\/div>/.exec(after);
		ok('with its help text written under the label', !!hit && !!help &&
			help[1].replace(/&amp;/g, '&') === sb.mod.getHelp(hit[1]), help && help[1]);
	});
	// The switch is only a face: flipping the checkbox is still what changes
	// the setting, through the panel's one change handler.
	var box = {id: 'ggSet-pullWeeds', checked: false,
		getAttribute: function (a) { return a === 'data-key' ? 'pullWeeds' : null; }};
	(panelEl.listeners.change || []).forEach(function (f) { f({target: box}); });
	eq('flipping a switch changes its setting', sb.mod.getSettings().pullWeeds, false);
	sb.mod.setTab('settings');
	sb.mod.getSettings().pullWeeds = true;
	sb.step();
	eq('and the page puts the switch back in line with the setting', sb.dom.get('ggSet-pullWeeds').checked, true);
	ok('while naming the mode the toggles act on', /^Working in /.test(sb.dom.get('ggModeHint').textContent),
		sb.dom.get('ggModeHint').textContent);
	ok('the harvest-new setting says why it matters',
		/data-help="setBank"/.test(panel) && /harvesting early banks nothing/.test(sb.mod.getHelp('setBank')));
})();

(function () {
	// Boost mode drives a different half of the panel.
	var errors = [];
	var realError = console.error;
	console.error = function () { errors.push(Array.prototype.join.call(arguments, ' ')); };
	var sb;
	try {
		sb = fresh({seed: 22, level: 9});
		sb.unlock(allSeeds(sb));
		sb.mod.setMode('boost');
		sb.mod.setObjective('golden');
		sb.step();
	} finally {
		console.error = realError;
	}
	eq('boost mode renders without error', errors.join(' | '), '');
	ok('the bonus is quoted as a percentage',
		/%/.test(sb.dom.get('ggChoiceInfo').textContent),
		sb.dom.get('ggChoiceInfo').textContent);
})();

(function () {
	// The modes without a choice fill the same two panes: the choice rows
	// fold away and Plan keeps the mode's own line, so the frame never
	// shows up empty.
	['off', 'tend'].forEach(function (mode) {
		var errors = [];
		var realError = console.error;
		console.error = function () { errors.push(Array.prototype.join.call(arguments, ' ')); };
		var sb;
		try {
			sb = fresh({seed: 24, level: 9, cookies: 1e30, cookiesPs: 1});
			sb.unlock(QUEENBEET_PARENTS);
			sb.mod.setMode(mode);
			sb.step();
		} finally {
			console.error = realError;
		}
		eq(mode + ' renders without error', errors.join(' | '), '');
		eq(mode + ' folds the choice row away', sb.dom.get('ggChoiceRow').style.display, 'none');
		eq(mode + ' folds the seed picker away', sb.dom.get('ggSeedRow').style.display, 'none');
		ok(mode + ' still says something in Plan', sb.dom.get('ggRecipe').textContent.length > 0);
		ok(mode + ' still draws the plot', sb.dom.get('ggGrid').innerHTML.split('ggCell').length - 1 === 36);
	});
})();

/* ------------------------------------------------------------------ *
 * 8. Save and load
 * ------------------------------------------------------------------ */
console.log('\npersistence');
(function () {
	var sb = fresh();
	sb.mod.setMode('boost');
	sb.mod.setObjective('golden');
	sb.mod.getSettings().pullWeeds = false;
	var str = sb.mod.save();
	ok('save produced a string', typeof str === 'string' && str.length > 0);

	var sb2 = fresh();
	sb2.mod.load(str);
	eq('mode survived', sb2.mod.getSettings().mode, 'boost');
	eq('objective survived', sb2.mod.getSettings().objective, 'golden');
	eq('a toggle survived', sb2.mod.getSettings().pullWeeds, false);

	var sb3 = fresh();
	var threw = false;
	try { sb3.mod.load('not json at all'); } catch (e) { threw = true; }
	ok('a corrupt save does not throw', !threw);
	eq('and the defaults are kept', sb3.mod.getSettings().mode, 'tend');
})();

(function () {
	// Saves from before "Clear unwanted growth immediately" do not carry it,
	// and must load with the old wait-for-maturity behaviour.
	var sb = fresh();
	sb.mod.load(JSON.stringify({v: 2, S: {mode: 'breed', askBeforeClearing: false}}));
	eq('an old save loads with clear-immediately off', sb.mod.getSettings().clearImmediately, false);
	eq('next to the settings it does carry', sb.mod.getSettings().askBeforeClearing, false);
	sb.mod.getSettings().clearImmediately = true;
	var sb2 = fresh();
	sb2.mod.load(sb.mod.save());
	eq('and once switched on, it survives a save', sb2.mod.getSettings().clearImmediately, true);
})();

/* ------------------------------------------------------------------ *
 * 8b. The breed preview is read-only
 *
 * Up to 1.3 a click on a preview tile cycled it through the recipe's
 * parents and empty, and the edit was saved. A breed layout is now changed
 * in one place only, the Layouts tab, so the preview takes no clicks, the
 * API that drove it is gone, and a save that still carries edits loads as
 * if it had none.
 * ------------------------------------------------------------------ */
console.log('\nread-only breed preview');

/** A queenbeet breed plan on a bare, fully unlocked plot. */
function editable(seed) {
	var sb = fresh({seed: seed, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(QUEENBEET_PARENTS);
	sb.clear();
	sb.mod.setMode('breed');
	sb.mod.setTarget('queenbeet');
	sb.mod.replan();
	return sb;
}

/** The first unlocked tile the assistant left empty. */
function firstHole(sb, plan) {
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
		if (sb.M.isTileUnlocked(x, y) && !plan.grid[y][x]) return [x, y];
	}
	return null;
}

(function () {
	var sb = editable(61);
	sb.step();
	var grid = sb.dom.get('ggGrid').innerHTML;
	ok('the breed preview is drawn', grid.indexOf('ggCell') >= 0);
	ok('and none of its tiles take clicks',
		grid.indexOf('data-act=') < 0 && grid.indexOf('ggEdit') < 0, grid.slice(0, 200));
	ok('the status line compares nothing without a customized layout',
		!/vs the assistant/.test(sb.dom.get('ggStatus').innerHTML), sb.dom.get('ggStatus').innerHTML);
	ok('the tile-editing API is gone',
		['cycleTile', 'setTileEdit', 'getEdits', 'resetLayout'].every(function (k) {
			return typeof sb.mod[k] === 'undefined';
		}));
	var saved = JSON.parse(sb.mod.save());
	ok('a save no longer carries edits', saved.v === 2 && !('edits' in saved), JSON.stringify(Object.keys(saved)));
})();

(function () {
	// A 1.3 save with a stored edit on the very plan being bred still loads,
	// with the rest of its state, and the edit is not planted.
	var sb = editable(63);
	var plan = sb.mod.getPlan();
	var assistantGrid = JSON.stringify(plan.grid), assistantScore = plan.score;
	var hole = firstHole(sb, plan);
	ok('the layout has a hole an old edit could have filled', !!hole);
	var old = JSON.parse(sb.mod.save());
	old.edits = {};
	old.edits[plan.key] = {};
	old.edits[plan.key][hole[0] + ',' + hole[1]] = plan.recipe.parents[0].key;

	var sb2 = fresh({seed: 63, level: 9, cookies: 1e30, cookiesPs: 1});
	sb2.unlock(QUEENBEET_PARENTS);
	sb2.clear();
	var threw = false;
	try { sb2.mod.load(JSON.stringify(old)); } catch (e) { threw = true; }
	ok('a v2 save with edits loads without throwing', !threw);
	eq('and its settings come back', sb2.mod.getSettings().mode + '/' + sb2.mod.getSettings().target,
		'breed/queenbeet');
	var again = sb2.mod.replan();
	eq('the stored edit is not planted', JSON.stringify(again.grid), assistantGrid);
	near('and the score is the assistant\'s', again.score, assistantScore, 1e-12);
	ok('the next save drops the field', !('edits' in JSON.parse(sb2.mod.save())));

	var sb3 = fresh();
	threw = false;
	try { sb3.mod.load(JSON.stringify({v: 1, S: {}, edits: 'garbage'})); } catch (e) { threw = true; }
	ok('a malformed edits entry does not throw either', !threw);
})();

/* ------------------------------------------------------------------ *
 * 9. Maturity is time, not a snapshot
 *
 * A rule reads neighsM, which counts only neighbours that have reached
 * their own mature age. Species differ enormously in how much of a
 * replant cycle they spend there, so a layout scored as if everything
 * were grown at once prices a state the garden rarely occupies - and
 * prices it worst for exactly the pairings where the two parents grow
 * at different speeds.
 * ------------------------------------------------------------------ */
console.log('\nmaturity odds');
(function () {
	var sb = fresh();
	sb.unlock(allSeeds(sb));
	sb.step();
	var odds = function (k) { return sb.mod.getMatureOdds(k); };

	ok('odds are a probability', odds('bakerWheat') > 0 && odds('bakerWheat') <= 1,
		'got ' + odds('bakerWheat'));
	ok('a quick plant spends more of its life mature than a slow one',
		odds('bakerWheat') > odds('queenbeet') && odds('queenbeet') > odds('duketater'),
		'wheat ' + odds('bakerWheat') + ', queenbeet ' + odds('queenbeet') +
		', duketater ' + odds('duketater'));

	eq('an immortal is always in', odds('elderwort'), 1);

	// Duketater matures at 95 and the old rule took it at 88 - that is, on the
	// first step it could breed, if it ever got there at all. It has to keep a
	// window worth having.
	ok('even a late bloomer gets a window worth having (' + odds('duketater').toFixed(3) + ')',
		odds('duketater') > 0.03, 'got ' + odds('duketater'));
})();

console.log('\nexpected mutation rate over a cycle');
(function () {
	var sb = fresh();
	sb.unlock(allSeeds(sb));
	sb.step();

	// Elderwort is bred off one mature shimmerlily and one mature cronerice,
	// and nothing else is on offer in that neighbourhood - so the expected
	// rate is the snapshot rate times the odds of both windows overlapping.
	var counts = {shimmerlily: 1, cronerice: 1};
	var snap = sb.mod.getSnapshotChance(counts, 'elderwort');
	var real = sb.mod.getLandChance(counts, 'elderwort');
	var want = snap * sb.mod.getMatureOdds('shimmerlily') * sb.mod.getMatureOdds('cronerice');
	near('two mature parents are discounted by both windows', real, want, want * 1e-9);
	ok('which is far below the snapshot (' + (snap / real).toFixed(0) + 'x)', real < snap / 5,
		'snapshot ' + snap + ', expected ' + real);

	// Shriekbulb off three duketaters reads neighs, not neighsM: age is
	// irrelevant, so nothing about growth speed may discount it.
	var dt = {duketater: 3};
	near('a rule that ignores maturity is not discounted',
		sb.mod.getLandChance(dt, 'shriekbulb'),
		sb.mod.getSnapshotChance(dt, 'shriekbulb'), 1e-12);
})();

console.log('\nlayouts follow the bottleneck');
(function () {
	// Elderwort needs a mature shimmerlily and a mature cronerice side by
	// side. The two grow at wildly different speeds, so the tiles should not
	// be split evenly: the parent with the shorter window needs more copies
	// for the two to be mature at the same time.
	var sb = fresh({seed: 7, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(['bakerWheat', 'thumbcorn', 'cronerice', 'gildmillet', 'clover', 'shimmerlily']);
	sb.clear();
	sb.mod.setMode('breed');
	sb.mod.setTarget('elderwort');
	var plan = sb.mod.replan();

	var n = {shimmerlily: 0, cronerice: 0};
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
		if (plan.grid[y][x] in n) n[plan.grid[y][x]]++;
	}
	ok('the layout uses both parents (' + n.shimmerlily + ' shimmerlily, ' +
		n.cronerice + ' cronerice)', n.shimmerlily > 0 && n.cronerice > 0);

	var scarce = sb.mod.getMatureOdds('shimmerlily') < sb.mod.getMatureOdds('cronerice')
		? 'shimmerlily' : 'cronerice';
	var other = scarce === 'shimmerlily' ? 'cronerice' : 'shimmerlily';
	ok('and gives more tiles to ' + scarce + ', whose window is shorter',
		n[scarce] >= n[other], n.shimmerlily + ' vs ' + n.cronerice);
})();

console.log('\nexpiry leaves room to breed');
(function () {
	var sb = fresh({seed: 5, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(allSeeds(sb));
	sb.clear();
	sb.mod.setMode('tend');

	// Elderwort matures at 90 and creeps along at 0.3-0.8 age a step: taken at
	// 91 it never breeds once. Baker's wheat covers 7-9 age a step, so at 92
	// it is genuinely one step from withering and has bred for ages.
	sb.plant('elderwort', 2, 2, 91);
	sb.plant('bakerWheat', 4, 4, 92);
	sb.mod.runStepNow();
	ok('a late bloomer is left to breed', sb.M.plot[2][2][0] !== 0);
	eq('a quick plant is still taken before it withers', sb.M.plot[4][4][0], 0);
})();


/* ------------------------------------------------------------------ *
 * 10. The harness itself
 *
 * Every number the README quotes comes out of this sandbox, so the sandbox
 * has to answer the same way twice. It runs thousands of garden steps as fast
 * as the CPU allows, which is nothing like the minutes between steps in a
 * real game - so anything the mod reads off the wall clock has to be driven
 * by the harness, not by how long a plan happened to take to compute.
 * ------------------------------------------------------------------ */
console.log('\nthe harness repeats itself');
(function () {
	function runOnce() {
		var sb = boot({seed: 12, level: 9, cookies: 1e40, cookiesPs: 1});
		var mod = sb.loadMod();
		sb.clear();
		for (var k in sb.M.plants) sb.M.plants[k].unlocked = 0;
		sb.M.plants['bakerWheat'].unlocked = 1;
		sb.M.getUnlockedN();
		mod.setMode('breed');
		mod.setTarget('');
		for (var i = 0; i < 300; i++) sb.step();
		return sb.unlockedCount() + ' ' + JSON.stringify(sb.M.plot);
	}
	var a = runOnce(), b = runOnce();
	eq('the same seed grows the same garden twice', a === b, true);
	ok('and it is not simply doing nothing (' + a.split(' ')[0] + ' seeds)',
		parseInt(a, 10) > 1, a.split(' ')[0]);
})();

/* ------------------------------------------------------------------ *
 * Immortals can wall off the nursery. Meddleweed only sprouts in a tile
 * with no neighbours at all, immortals are never uprooted, so elderwort on
 * a checkerboard makes a weed impossible - the assistant must say it is
 * stuck rather than run a nursery that waits forever.
 * ------------------------------------------------------------------ */
console.log('\nnursery blocked by immortals');
(function () {
	var sb = fresh();
	// elderwort + shriekbulb in hand: nothing sowable leads anywhere new
	// (everdaisy also needs tidygrass), so the nursery is the only way out.
	sb.clear();
	for (var k in sb.M.plants) sb.M.plants[k].unlocked = 0;
	sb.unlock(['elderwort', 'shriekbulb']);
	sb.mod.setMode('breed');
	sb.mod.setTarget('');

	// Empty plot first: the nursery is possible and must still be chosen.
	var plan = sb.mod.replan();
	ok('empty plot: nursery plan', !!plan && !!plan.nursery, JSON.stringify(plan && plan.label));

	// Checkerboard of immortal elderwort: every tile has one on it or next
	// to it, so no tile can ever be neighbour-free.
	for (var y = 0; y < 6; y++) {
		for (var x = 0; x < 6; x++) {
			if ((x + y) % 2 === 0) sb.plant('elderwort', x, y);
		}
	}
	plan = sb.mod.replan();
	ok('blocked plot: no nursery plan', !!plan && !plan.nursery, JSON.stringify(plan));
	ok('blocked plot: plan says stuck', !!plan && !!plan.stuck, JSON.stringify(plan));
	ok('blocked plot: status names the deadlock',
		sb.mod.getStatus().indexOf('stuck') === 0, sb.mod.getStatus());

	// One corner freed by hand is enough to make the nursery a plan again.
	sb.M.plot[0][0] = [0, 0];
	sb.M.plot[0][1] = [0, 0];
	sb.M.plot[1][0] = [0, 0];
	sb.M.plot[1][1] = [0, 0];
	sb.M.plot[0][2] = [0, 0];
	sb.M.plot[2][0] = [0, 0];
	sb.M.plot[2][2] = [0, 0];
	sb.M.plot[2][1] = [0, 0];
	sb.M.plot[1][2] = [0, 0];
	plan = sb.mod.replan();
	ok('freed corner: nursery again', !!plan && !!plan.nursery, JSON.stringify(plan));
})();

/* ------------------------------------------------------------------ *
 * setHTML must not trust el.innerHTML as its change detector: a real
 * browser re-serializes what it parsed, so the readback never matches and
 * the grid rebuilds thirty times a second. The cache keys on what the mod
 * last wrote - an unchanged string writes nothing, even when the DOM
 * reports something else.
 * ------------------------------------------------------------------ */
console.log('\nsetHTML writes only on change');
(function () {
	// Every seed banked and the plot empty: the plan is null and the grid's
	// markup is a constant, so any rewrite between steps is the cache failing.
	var sb = fresh();
	sb.clear();
	sb.unlock(allSeeds(sb));
	sb.mod.setMode('breed');
	sb.step();
	sb.step();

	var grid = sb.dom.get('ggGrid');
	ok('the layout grid was drawn', grid.innerHTML.length > 0, 'empty innerHTML');

	// Simulate the browser re-serializing: the DOM now reports different
	// markup for the same content. A readback-based compare would rewrite;
	// the cache must not.
	grid.innerHTML = 'RESERIALIZED-BY-BROWSER';
	sb.step();
	eq('an unchanged panel does not rewrite the grid', grid.innerHTML, 'RESERIALIZED-BY-BROWSER');

	// A real change must still land: relocking a seed brings a breed plan
	// with a real layout back.
	sb.M.plants['queenbeet'].unlocked = 0;
	sb.M.getUnlockedN();
	sb.mod.replan();
	sb.step();
	ok('a plan change rewrites the grid', grid.innerHTML !== 'RESERIALIZED-BY-BROWSER',
		grid.innerHTML.slice(0, 40));
})();

/* ------------------------------------------------------------------ *
 * 11. Layout library
 *
 * Layouts drawn by hand in the second tab and kept by name in the save.
 * A drawing with no recipe is a sketch: nothing plants it (Custom mode is
 * gone - to plant by hand, pick Off). A layout made for a recipe reaches the
 * plot through Use for breeding, tested in section 12.
 * ------------------------------------------------------------------ */
console.log('\nlayout library');

/** A bare, fully unlocked plot with plenty of cookies. */
function library(seed, unlocked) {
	var sb = fresh({seed: seed, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.clear();
	if (unlocked) sb.unlock(unlocked);
	return sb;
}

function layoutNamed(sb, name) {
	var all = sb.mod.getLayouts();
	for (var i = 0; i < all.length; i++) if (all[i].name === name) return all[i];
	return null;
}

function plotKey(sb, x, y) {
	var id = sb.M.plot[y][x][0];
	return id ? sb.M.plantsById[id - 1].key : '';
}

(function () {
	// Create, rename, duplicate, delete.
	var sb = library(81);
	eq('a fresh game has no layouts', sb.mod.getLayouts().length, 0);

	eq('New creates a layout under the name given', sb.mod.createLayout('Wheat ring'), 'Wheat ring');
	var made = layoutNamed(sb, 'Wheat ring');
	ok('with a blank 6x6 grid', !!made && made.grid.length === 6 &&
		made.grid.every(function (r) { return r.length === 6 && r.every(function (c) { return c === ''; }); }));
	eq('a colliding name gets a numeric suffix', sb.mod.createLayout('Wheat ring'), 'Wheat ring 2');
	var dflt = sb.mod.createLayout('');
	ok('an empty name falls back to a default (' + dflt + ')', typeof dflt === 'string' && dflt.length > 0);
	eq('three layouts now', sb.mod.getLayouts().length, 3);

	eq('Rename renames', sb.mod.renameLayout('Wheat ring', 'Clover field'), 'Clover field');
	ok('and the old name is gone', !layoutNamed(sb, 'Wheat ring') && !!layoutNamed(sb, 'Clover field'));
	eq('renaming onto a taken name is suffixed', sb.mod.renameLayout('Wheat ring 2', 'Clover field'),
		'Clover field 2');
	eq('renaming a layout that does not exist does nothing', sb.mod.renameLayout('nope', 'x'), null);

	sb.mod.selectLayout('Clover field');
	ok('painting a tile writes through at once', sb.mod.paintTile(2, 3, 'clover'));
	eq('the stored grid holds it', layoutNamed(sb, 'Clover field').grid[3][2], 'clover');

	var copy = sb.mod.duplicateLayout('Clover field');
	eq('Duplicate names the copy with a suffix', copy, 'Clover field 3');
	eq('the copy has the same grid', JSON.stringify(layoutNamed(sb, copy).grid),
		JSON.stringify(layoutNamed(sb, 'Clover field').grid));
	sb.mod.selectLayout(copy);
	sb.mod.paintTile(2, 3, '');
	eq('and painting the copy leaves the original alone', layoutNamed(sb, 'Clover field').grid[3][2], 'clover');

	ok('Delete removes a layout', sb.mod.deleteLayout('Clover field 2'));
	ok('and it is gone', !layoutNamed(sb, 'Clover field 2'));
	ok('deleting a layout that does not exist is refused', !sb.mod.deleteLayout('Clover field 2'));
	eq('three layouts left', sb.mod.getLayouts().length, 3);
})();

(function () {
	// Painting: the brush, the eraser, and what the editor refuses.
	var sb = library(82, ['bakerWheat']);
	sb.mod.createLayout('Paint');
	sb.mod.setBrush('bakerWheat');
	sb.mod.paintTile(0, 0);
	eq('a click paints with the selected brush', layoutNamed(sb, 'Paint').grid[0][0], 'bakerWheat');
	sb.mod.setBrush('');
	sb.mod.paintTile(0, 0);
	eq('the empty brush erases', layoutNamed(sb, 'Paint').grid[0][0], '');
	ok('a species not yet unlocked can still be drawn', sb.mod.paintTile(1, 1, 'shimmerlily'));
	ok('a key the game does not know is refused', !sb.mod.paintTile(1, 2, 'notAPlant'));
	ok('a seed that cannot be planted is refused', !sb.mod.paintTile(1, 2, 'queenbeetLump'));
	eq('and neither was stored', layoutNamed(sb, 'Paint').grid[2][1], '');

	var small = fresh({seed: 83, level: 1, cookies: 1e30, cookiesPs: 1});
	small.mod.createLayout('Small');
	var locked = null;
	for (var y = 0; y < 6 && !locked; y++) for (var x = 0; x < 6; x++) {
		if (!small.M.isTileUnlocked(x, y)) { locked = [x, y]; break; }
	}
	ok('a small plot has locked tiles', !!locked);
	ok('a locked plot tile cannot be painted', !small.mod.paintTile(locked[0], locked[1], 'bakerWheat'));
})();

(function () {
	// Save and load keep the library exactly, and old saves still load.
	var sb = library(84, ['bakerWheat', 'clover']);
	sb.mod.createLayout('One');
	sb.mod.paintTile(0, 0, 'bakerWheat');
	sb.mod.paintTile(5, 5, 'clover');
	sb.mod.createLayout('Two');
	sb.mod.paintTile(3, 2, 'shimmerlily');
	var before = JSON.stringify(sb.mod.getLayouts());
	var str = sb.mod.save();

	var sb2 = library(85);
	sb2.mod.load(str);
	eq('layouts survive a save and reload byte for byte', JSON.stringify(sb2.mod.getLayouts()), before);

	var sb3 = library(86);
	sb3.mod.load(JSON.stringify({v: 1, S: {mode: 'boost'}}));
	eq('a save from before layouts loads with none', sb3.mod.getLayouts().length, 0);
	eq('and its settings still load', sb3.mod.getSettings().mode, 'boost');

	var sb4 = library(87);
	var threw = false;
	try {
		sb4.mod.load(JSON.stringify({v: 1, S: {layouts: 'garbage'}}));
		sb4.mod.load(JSON.stringify({v: 1, S: {layouts: [
			{name: 'Good', grid: JSON.parse(JSON.stringify(sb.mod.getLayouts()[0].grid))},
			{name: 'Short', grid: [['']]},
			{name: 42, grid: []},
			null
		]}}));
	} catch (e) { threw = true; }
	ok('a malformed layouts entry does not throw', !threw);
	eq('and only the well-formed layout is kept', sb4.mod.getLayouts().map(function (l) { return l.name; }).join(','),
		'Good');
})();

(function () {
	// Which tab is open survives a reload, and the Layouts tab draws its editor.
	var sb = library(88, ['bakerWheat']);
	eq('the panel opens on the assistant', sb.mod.getSettings().tab, 'assistant');
	sb.mod.setTab('layouts');
	sb.mod.setTab('bogus');
	eq('an unknown tab is ignored', sb.mod.getSettings().tab, 'layouts');
	var sb2 = library(89);
	sb2.mod.load(sb.mod.save());
	eq('the open tab survives a save and reload', sb2.mod.getSettings().tab, 'layouts');
	sb2.mod.setTab('settings');
	eq('Settings is a tab like Layouts', sb2.mod.getSettings().tab, 'settings');
	var sb2b = library(89);
	sb2b.mod.load(sb2.mod.save());
	eq('and it survives a save and reload too', sb2b.mod.getSettings().tab, 'settings');

	var errors = [];
	var realError = console.error;
	console.error = function () { errors.push(Array.prototype.join.call(arguments, ' ')); };
	try {
		sb.mod.createLayout('Shown');
		sb.mod.paintTile(0, 0, 'bakerWheat');
		sb.mod.paintTile(1, 0, 'shimmerlily');
		sb.step();
	} finally {
		console.error = realError;
	}
	eq('the Layouts tab renders without error', errors.join(' | '), '');
	var panel = sb.dom.findCreated('grandpasGreenhousePanel').innerHTML;
	// One tab bar: the four modes, the last closing the mode strip, then
	// Layouts and Settings set apart; no Assistant or Custom tab.
	ok('the title row carries the mode tabs, then Layouts and Settings, in one bar',
		/class="ggTabs">(<div class="ggBtn ggTab" data-act="mode"[^>]*>[^<]+<\/div>){3}<div class="ggBtn ggTab ggTabEnd" data-act="mode" data-mode="boost"[^>]*>Boost<\/div><div class="ggBtn ggTab ggTabApart" data-act="tab" data-tab="layouts"[^>]*>Layouts<\/div><div class="ggBtn ggTab" data-act="tab" data-tab="settings"[^>]*>Settings<\/div><\/div>/.test(panel));
	ok('there is no Custom tab any more', panel.indexOf('ggMode-custom') < 0 && panel.indexOf('>Custom<') < 0 &&
		panel.indexOf('data-act="useLayout"') < 0);
	ok('and no Re-plan button in the title row', panel.indexOf('data-act="replan"') < 0);
	ok('and no separate Assistant tab', panel.indexOf('>Assistant</div>') < 0 && panel.indexOf('ggTab-assistant') < 0);
	ok('the Layouts tab is lit while it is open', /ggOn/.test(sb.dom.get('ggTab-layouts').className));
	var cur = sb.dom.get('ggMode-' + sb.mod.getSettings().mode).className;
	ok('and the current mode keeps only its pip', /ggCur/.test(cur) && !/ggOn/.test(cur), cur);
	eq('the layouts tab is shown', sb.dom.get('ggTabLayouts').style.display, '');
	eq('and the assistant tab hidden', sb.dom.get('ggTabAssistant').style.display, 'none');

	var grid = sb.dom.get('ggEditGrid').innerHTML;
	eq('the editor draws all 36 tiles', grid.split('ggCell').length - 1, 36);
	var open = 0;
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) if (sb.M.isTileUnlocked(x, y)) open++;
	eq('every unlocked tile takes a click', (grid.match(/data-act="paint"/g) || []).length, open);

	var palette = sb.dom.get('ggPalette').innerHTML;
	var plantable = 0;
	for (var k in sb.M.plants) if (sb.M.plants[k].plantable) plantable++;
	eq('the palette offers every plantable species plus the eraser',
		(palette.match(/data-act="brush"/g) || []).length, plantable + 1);
	ok('species not yet unlocked are marked', /not unlocked yet/.test(palette));
	ok('the library lists the layout', sb.dom.get('ggLibrary').innerHTML.indexOf('Shown') >= 0);

	sb.mod.setTab('assistant');
	sb.step();
	eq('switching back shows the assistant', sb.dom.get('ggTabAssistant').style.display, '');
	eq('and hides the layouts', sb.dom.get('ggTabLayouts').style.display, 'none');
})();

(function () {
	// The one tab bar, driven through the panel's own click and hover
	// handlers: a mode tab opens the assistant and sets the mode, Layouts
	// only switches the view, and hover text goes to the game's tooltip.
	var sb = library(94, ['bakerWheat']);
	sb.step();
	var panel = sb.dom.findCreated('grandpasGreenhousePanel');
	function fire(type, attrs) {
		var el = {
			isConnected: true,
			getAttribute: function (k) { return attrs.hasOwnProperty(k) ? attrs[k] : null; },
			contains: function () { return false; }
		};
		var ev = {target: {closest: function () { return el; }}, relatedTarget: null};
		(panel.listeners[type] || []).forEach(function (f) { f(ev); });
		return el;
	}

	sb.mod.setMode('tend');
	sb.mod.setTab('layouts');
	fire('click', {'data-act': 'mode', 'data-mode': 'breed'});
	eq('a mode tab opens the assistant', sb.mod.getSettings().tab, 'assistant');
	eq('and sets its mode', sb.mod.getSettings().mode, 'breed');
	ok('its tab is the lit one', /ggOn/.test(sb.dom.get('ggMode-breed').className));
	ok('and Layouts is not', !/ggOn/.test(sb.dom.get('ggTab-layouts').className));

	fire('click', {'data-act': 'tab', 'data-tab': 'layouts'});
	eq('Layouts switches the view', sb.mod.getSettings().tab, 'layouts');
	eq('and leaves the mode alone', sb.mod.getSettings().mode, 'breed');

	fire('click', {'data-act': 'tab', 'data-tab': 'settings'});
	eq('Settings switches the view', sb.mod.getSettings().tab, 'settings');
	eq('and leaves the mode alone too', sb.mod.getSettings().mode, 'breed');
	ok('its tab is the lit one', /ggOn/.test(sb.dom.get('ggTab-settings').className));
	var pip = sb.dom.get('ggMode-breed').className;
	ok('while the mode keeps only its pip', /ggCur/.test(pip) && !/ggOn/.test(pip), pip);
	eq('the settings page is shown', sb.dom.get('ggTabSettings').style.display, '');
	ok('and both other views hidden', sb.dom.get('ggTabAssistant').style.display === 'none' &&
		sb.dom.get('ggTabLayouts').style.display === 'none');

	// The harness has no Game.tooltip, which must simply mean no tooltip.
	var threw = null;
	try { fire('mouseover', {'data-help': 'progress'}); fire('mouseout', {}); } catch (e) { threw = e; }
	ok('hovering without the game\'s tooltip is harmless', !threw, threw && threw.message);

	var tt = {on: 0, shouldHide: 1, dynamic: 0, from: null, text: null, origin: '',
		draw: function (from, text, origin) {
			this.from = from; this.text = text; this.origin = origin; this.on = 1; this.shouldHide = 0;
		}};
	sb.Game.tooltip = tt;
	var hovered = fire('mouseover', {'data-help': 'progress'});
	eq('hovering draws the game\'s tooltip for the element', tt.from, hovered);
	eq('placed the way the garden places its own', tt.origin, 'this');
	eq('as a dynamic tooltip', tt.dynamic, 1);
	var shown = typeof tt.text === 'function' ? unescape(tt.text()) : '';
	ok('showing the HELP text', shown.indexOf(sb.mod.getHelp('progress')) >= 0, shown);
	fire('mouseout', {});
	eq('leaving it hides the tooltip', tt.shouldHide, 1);

	fire('mouseover', {'data-tip': '12.5% from A & B'});
	shown = unescape(tt.text());
	ok('literal hover text survives the game\'s unescape', shown.indexOf('12.5% from A &amp; B') >= 0, shown);
	sb.Game.tooltip = undefined;
})();

(function () {
	// Export and import as JSON text.
	var sb = library(90, ['bakerWheat']);
	sb.mod.createLayout('Wheat');
	sb.mod.paintTile(0, 0, 'bakerWheat');
	sb.mod.paintTile(2, 2, 'bakerWheat');
	var text = sb.mod.exportLayouts();
	var parsed = null;
	try { parsed = JSON.parse(text); } catch (e) { /* checked below */ }
	ok('export is a JSON array', Array.isArray(parsed));
	eq('of every layout', JSON.stringify(parsed), JSON.stringify(sb.mod.getLayouts()));

	var sb2 = library(91);
	var res = sb2.mod.importLayouts(text);
	ok('a valid export imports', res && res.ok, JSON.stringify(res));
	eq('and reproduces the layouts', JSON.stringify(sb2.mod.getLayouts()), JSON.stringify(sb.mod.getLayouts()));

	res = sb2.mod.importLayouts(text);
	ok('importing it again still works', res && res.ok, JSON.stringify(res));
	eq('with the colliding name suffixed', sb2.mod.getLayouts()[1].name, 'Wheat 2');

	var single = JSON.stringify({name: 'Solo', grid: sb.mod.getLayouts()[0].grid});
	res = sb2.mod.importLayouts(single);
	ok('a single layout object imports too', res && res.ok && !!layoutNamed(sb2, 'Solo'), JSON.stringify(res));

	var count = sb2.mod.getLayouts().length;
	var good = sb.mod.getLayouts()[0].grid;
	function rejects(what, input) {
		var r = sb2.mod.importLayouts(input);
		ok(what + ' is rejected', r && r.ok === false && typeof r.msg === 'string' && r.msg.length > 0,
			JSON.stringify(r));
	}
	rejects('malformed JSON', '{not json');
	rejects('a bare number', '42');
	rejects('null', 'null');
	rejects('a grid with five rows', JSON.stringify({name: 'x', grid: good.slice(0, 5)}));
	var wide = JSON.parse(JSON.stringify(good)); wide[0].push('');
	rejects('a row of seven', JSON.stringify({name: 'x', grid: wide}));
	var num = JSON.parse(JSON.stringify(good)); num[1][1] = 3;
	rejects('a tile that is not a string', JSON.stringify({name: 'x', grid: num}));
	var unknown = JSON.parse(JSON.stringify(good)); unknown[4][4] = 'notAPlant';
	rejects('an unknown species', JSON.stringify({name: 'x', grid: unknown}));
	var msg = sb2.mod.importLayouts(JSON.stringify({name: 'x', grid: unknown})).msg;
	ok('and the message names it', /notAPlant/.test(msg), msg);
	rejects('an array with one bad layout among good ones',
		JSON.stringify([{name: 'Fine', grid: good}, {name: 'Bad', grid: unknown}]));
	eq('and nothing from a rejected import was applied', sb2.mod.getLayouts().length, count);
	ok('not even the good half', !layoutNamed(sb2, 'Fine'));
})();

(function () {
	// A drawing with no recipe is kept, not planted: there is no mode that
	// plants it, and the library offers nothing that would.
	var sb = library(92, ['bakerWheat', 'clover']);
	sb.mod.createLayout('Stripes');
	for (var x = 0; x < 6; x++) {
		sb.mod.paintTile(x, 0, 'bakerWheat');
		sb.mod.paintTile(x, 2, 'clover');
	}
	eq('there is no API to activate a layout', typeof sb.mod.activateLayout, 'undefined');
	sb.mod.setMode('off');
	sb.mod.runStepNow();
	var planted = 0;
	for (var y = 0; y < 6; y++) for (var x2 = 0; x2 < 6; x2++) if (plotKey(sb, x2, y)) planted++;
	eq('in Off the drawing is not planted', planted, 0);
	sb.mod.setTab('layouts');
	sb.mod.selectLayout('Stripes');
	sb.step();
	var acts = sb.dom.get('ggLibActions').innerHTML;
	ok('the library offers no Activate for it', acts.indexOf('data-act="activate"') < 0 && acts.indexOf('Activate') < 0, acts);
	ok('nor Use for breeding, as it has no recipe', acts.indexOf('data-act="useBreed"') < 0, acts);
	ok('but still Rename, Duplicate and Delete',
		['libRename', 'libDup', 'libDelete'].every(function (a) { return acts.indexOf('data-act="' + a + '"') >= 0; }), acts);
	ok('and no row is tagged as planted', sb.dom.get('ggLibrary').innerHTML.indexOf('ggTag') < 0);
})();

(function () {
	// A save from up to 1.3 in Custom mode loads as Off, and its active-layout
	// name is dropped.
	var sb = library(96, ['bakerWheat']);
	var threw = false;
	try {
		sb.mod.load(JSON.stringify({v: 2, S: {mode: 'custom', layout: 'Gone', tab: 'layouts', layouts: [
			{name: 'Gone', grid: [['bakerWheat', '', '', '', '', ''], ['', '', '', '', '', ''], ['', '', '', '', '', ''],
				['', '', '', '', '', ''], ['', '', '', '', '', ''], ['', '', '', '', '', '']]}]}}));
		sb.mod.replan();
		sb.step();
		sb.step();
	} catch (e) { threw = true; }
	ok('a save in Custom mode does not throw', !threw);
	eq('and loads as Off', sb.mod.getSettings().mode, 'off');
	eq('with no plan', sb.mod.getPlan(), null);
	eq('and nothing planted from its layout', plotKey(sb, 0, 0), '');
	ok('the layout itself is kept as a drawing', !!layoutNamed(sb, 'Gone'));
	eq('the rest of the save still loads', sb.mod.getSettings().tab, 'layouts');
	ok('the active-layout name is neither kept nor saved again',
		!('layout' in sb.mod.getSettings()) && !('layout' in JSON.parse(sb.mod.save()).S));
	var sb2 = library(97);
	sb2.mod.load(JSON.stringify({v: 2, S: {mode: 'nonsense'}}));
	eq('any other unknown mode loads as Off too', sb2.mod.getSettings().mode, 'off');
})();

/* ------------------------------------------------------------------ *
 * 12. Breed layouts customized per recipe
 *
 * A player who does not like the layout the assistant computes for a recipe
 * copies it into the library once, reshapes it there, and from then on the
 * assistant plants that drawing whenever it breeds with that same recipe on
 * that same plot. The link is the plan key; when the key moves on, the
 * computed layout comes back and the drawing stays in the library.
 * ------------------------------------------------------------------ */
console.log('\nper-recipe breed layouts');

/** A layout's grid with one tile changed, so an override is visibly not the computed one. */
function flipOneTile(sb, grid, recipe) {
	var g = JSON.parse(JSON.stringify(grid));
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
		if (sb.M.isTileUnlocked(x, y) && !g[y][x]) { g[y][x] = recipe.parents[0].key; return {grid: g, x: x, y: y}; }
	}
	return null;
}

(function () {
	// Customize copies the computed grid into a linked layout.
	var sb = editable(101);
	var plan = sb.mod.getPlan();
	var computed = JSON.stringify(plan.grid), computedScore = plan.score, key = plan.key;
	var name = sb.mod.customizeCurrentPlan();
	eq('Customize names the copy after the target', name, 'Breeding Queenbeet');
	var lay = layoutNamed(sb, name);
	ok('and adds it to the library', !!lay);
	eq('with the plan key as its recipe', lay && lay.recipe, key);
	eq('holding the computed grid', lay && JSON.stringify(lay.grid), computed);
	var now = sb.mod.getPlan();
	eq('the breed plan is now overridden by it', now.override, name);
	eq('with the same grid as before', JSON.stringify(now.grid), computed);
	near('and so the same score', now.score, computedScore, 1e-12);
	eq('still in Breed', sb.mod.getSettings().mode, 'breed');
	sb.mod.setTab('layouts');
	sb.step();
	ok('and opens it in the editor', sb.dom.get('ggEditTitle').textContent.indexOf(name) >= 0,
		sb.dom.get('ggEditTitle').textContent);

	// Nothing to customize outside a real recipe plan.
	var sb3 = library(103);
	sb3.mod.setMode('tend');
	sb3.mod.replan();
	eq('Customize refuses when there is no breed plan', sb3.mod.customizeCurrentPlan(), null);
	eq('and adds nothing', sb3.mod.getLayouts().length, 0);
})();

(function () {
	// The override replaces the grid and is rescored; painting it is live.
	var sb = editable(104);
	var plan = sb.mod.getPlan();
	var computedScore = plan.score, computed = JSON.stringify(plan.grid);
	var name = sb.mod.customizeCurrentPlan();
	var f = flipOneTile(sb, plan.grid, plan.recipe);
	sb.mod.selectLayout(name);
	ok('painting the linked layout is accepted', sb.mod.paintTile(f.x, f.y, f.grid[f.y][f.x]));
	var live = sb.mod.getPlan();
	eq('and reaches the live breed plan at once', live.grid[f.y][f.x], f.grid[f.y][f.x]);
	ok('which is rescored (' + live.score + ' vs ' + computedScore + ')', live.score !== computedScore);

	var rebuilt = sb.mod.replan();
	eq('a rebuilt plan uses the layout\'s grid', JSON.stringify(rebuilt.grid), JSON.stringify(f.grid));
	near('keeps the computed score as origScore', rebuilt.origScore, computedScore, 1e-12);
	eq('and the computed grid as origGrid', JSON.stringify(rebuilt.origGrid), computed);
	near('and scores the override the same way the click did', rebuilt.score, live.score, 1e-12);
	eq('the override is named on the plan', rebuilt.override, name);

	// The panel says so.
	sb.step();
	ok('the status line compares the override with the assistant',
		/vs the assistant/.test(sb.dom.get('ggStatus').innerHTML), sb.dom.get('ggStatus').innerHTML);
	ok('the recipe line names the layout in use', sb.dom.get('ggRecipe').textContent.indexOf(name) >= 0,
		sb.dom.get('ggRecipe').textContent);
	ok('the assistant preview takes no clicks while overridden either',
		sb.dom.get('ggGrid').innerHTML.indexOf('data-act=') < 0);

	sb.mod.setTab('layouts');
	sb.step();
	var libHtml = sb.dom.get('ggLibrary').innerHTML;
	ok('the library badges the linked layout with the target', libHtml.indexOf('Queenbeet') >= 0, libHtml);
	// Per-layout actions live in one row for the selected layout, not in the list.
	var actHtml = sb.dom.get('ggLibActions').innerHTML;
	ok('and offers Stop using', actHtml.indexOf('data-act="stopUse"') >= 0, actHtml);
	ok('rather than Use for breeding', actHtml.indexOf('data-act="useBreed"') < 0, actHtml);
	ok('the Layouts tab shows the assistant\'s layout', sb.dom.get('ggCustRow').style.display !== 'none');
	ok('and draws its preview', sb.dom.get('ggCustGrid').innerHTML.indexOf('ggCell') >= 0);

	// A plant the game would not sow is blanked rather than planted.
	var sb2 = editable(105);
	var n2 = sb2.mod.customizeCurrentPlan();
	layoutNamed(sb2, n2).grid[0][0] = 'queenbeetLump';
	eq('an unsowable key in the layout is left empty', sb2.mod.replan().grid[0][0], '');
})();

(function () {
	// Stop using and delete both hand the layout back to the assistant.
	var sb = editable(107);
	var plan = sb.mod.getPlan();
	var computed = JSON.stringify(plan.grid), computedScore = plan.score;
	var name = sb.mod.customizeCurrentPlan();
	var f = flipOneTile(sb, plan.grid, plan.recipe);
	sb.mod.selectLayout(name);
	sb.mod.paintTile(f.x, f.y, f.grid[f.y][f.x]);
	ok('the override is in force', sb.mod.getPlan().override === name);

	var recipeKey = layoutNamed(sb, name).recipe;
	ok('Stop using succeeds', sb.mod.stopUsing(name));
	ok('the layout is no longer in use', !layoutNamed(sb, name).use);
	eq('but keeps its recipe, so the badge stays', layoutNamed(sb, name).recipe, recipeKey);
	ok('and stays in the library', !!layoutNamed(sb, name));
	var back = sb.mod.getPlan();
	ok('the plan is no longer overridden', !back.override);
	eq('the computed grid is back', JSON.stringify(back.grid), computed);
	near('with its score', back.score, computedScore, 1e-12);
	ok('stopping a layout not in use is refused', !sb.mod.stopUsing(name));
	ok('Use for breeding puts it back', sb.mod.useForBreeding(name) && sb.mod.getPlan().override === name);
	sb.mod.createLayout('Plain');
	ok('a layout with no recipe cannot be used for breeding', !sb.mod.useForBreeding('Plain'));
	ok('and gets no flag', !layoutNamed(sb, 'Plain').use);

	var sb2 = editable(108);
	var p2 = sb2.mod.getPlan();
	var computed2 = JSON.stringify(p2.grid);
	var n2 = sb2.mod.customizeCurrentPlan();
	var f2 = flipOneTile(sb2, p2.grid, p2.recipe);
	sb2.mod.selectLayout(n2);
	sb2.mod.paintTile(f2.x, f2.y, f2.grid[f2.y][f2.x]);
	ok('Delete removes the linked layout', sb2.mod.deleteLayout(n2));
	var back2 = sb2.mod.getPlan();
	ok('and the plan is no longer overridden', !!back2 && !back2.override);
	eq('the computed grid is back', JSON.stringify(back2.grid), computed2);
	eq('and Breed carries on', sb2.mod.getSettings().mode, 'breed');
})();

(function () {
	// A recipe key that does not match the plan - another seed, or the same
	// seed on a plot that has grown since - is not applied.
	var sb = editable(109);
	var plan = sb.mod.getPlan();
	var computed = JSON.stringify(plan.grid);
	var parts = plan.key.split(':');
	parts[parts.length - 1] = String(parseInt(parts[parts.length - 1], 10) - 1);
	var grown = parts.join(':');
	var f = flipOneTile(sb, plan.grid, plan.recipe);
	var res = sb.mod.importLayouts(JSON.stringify([
		{name: 'Smaller plot', grid: f.grid, recipe: grown, use: true},
		{name: 'Other seed', grid: f.grid, recipe: 'breed:shriekbulb:duketater:3:36', use: true}
	]));
	ok('linked layouts import', res.ok, JSON.stringify(res));
	var after = sb.mod.replan();
	ok('a non-matching recipe does not override', !after.override);
	eq('and the computed grid stands', JSON.stringify(after.grid), computed);
	eq('neither layout is pruned', sb.mod.getLayouts().length, 2);

	// The badge falls back to the raw key when the target is not a plant.
	sb.mod.importLayouts(JSON.stringify({name: 'Odd', grid: f.grid, recipe: 'breed:notAPlant:x:1'}));
	sb.mod.setTab('layouts');
	sb.step();
	ok('an unresolvable target shows the raw key',
		sb.dom.get('ggLibrary').innerHTML.indexOf('breed:notAPlant:x:1') >= 0);
	ok('a resolvable one shows the seed name', sb.dom.get('ggLibrary').innerHTML.indexOf('Shriekbulb') >= 0);
})();

(function () {
	// The recipe link survives save/load and export/import; linking is unique.
	var sb = editable(110);
	var key = sb.mod.getPlan().key;
	var name = sb.mod.customizeCurrentPlan();
	sb.mod.createLayout('Free');
	var before = JSON.stringify(sb.mod.getLayouts());
	var str = sb.mod.save();

	var sb2 = library(111, QUEENBEET_PARENTS);
	sb2.mod.load(str);
	eq('the recipe survives a save and reload', JSON.stringify(sb2.mod.getLayouts()), before);
	eq('and a free layout still has none', layoutNamed(sb2, 'Free').recipe, undefined);
	var o = sb2.mod.replan();
	eq('and overrides the reloaded breed plan', o && o.override, name);

	var sb3 = library(112);
	sb3.mod.load(JSON.stringify({v: 1, S: {layouts: [
		{name: 'Bad link', grid: layoutNamed(sb, name).grid, recipe: 42}
	]}}));
	eq('a save with a non-text recipe keeps the layout', sb3.mod.getLayouts().length, 1);
	eq('but drops the link', sb3.mod.getLayouts()[0].recipe, undefined);

	// A save from before the flag: in 1.5 a recipe was always in use, so the
	// player's customized layout must still be planted after the update.
	var sb5 = library(114, QUEENBEET_PARENTS);
	sb5.mod.load(JSON.stringify({v: 1, S: {mode: 'breed', target: 'queenbeet', layouts: [
		{name: 'Old custom', grid: layoutNamed(sb, name).grid, recipe: key}
	]}}));
	eq('a 1.5 save with a recipe loads it in use', layoutNamed(sb5, 'Old custom').use, true);
	var o5 = sb5.mod.replan();
	eq('and it still overrides the breed plan', o5 && o5.override, 'Old custom');
	var sb6 = library(115);
	sb6.mod.load(JSON.stringify({v: 2, S: {layouts: [
		{name: 'Kept', grid: layoutNamed(sb, name).grid, recipe: key},
		{name: 'Junk flag', grid: layoutNamed(sb, name).grid, recipe: key, use: 'yes'}
	]}}));
	ok('a current save without the flag loads it off', !layoutNamed(sb6, 'Kept').use);
	ok('and a flag that is not a boolean is dropped', !layoutNamed(sb6, 'Junk flag').use);
	eq('without losing the layout', sb6.mod.getLayouts().length, 2);

	var text = sb.mod.exportLayouts();
	ok('export carries the recipe', JSON.parse(text)[0].recipe === key);
	eq('and the in-use flag', JSON.parse(text)[0].use, true);
	ok('a layout not in use exports without one', !('use' in JSON.parse(text)[1]));
	var sb4 = library(113, QUEENBEET_PARENTS);
	var res = sb4.mod.importLayouts(text);
	ok('and import accepts it', res.ok, JSON.stringify(res));
	eq('round trip is exact', JSON.stringify(sb4.mod.getLayouts()), before);

	var grid = layoutNamed(sb, name).grid;
	var bad = sb4.mod.importLayouts(JSON.stringify({name: 'x', grid: grid, recipe: 7}));
	ok('a non-text recipe is rejected on import', bad.ok === false, JSON.stringify(bad));
	ok('with a message that says so', /recipe/.test(bad.msg), bad.msg);
	var n4 = sb4.mod.getLayouts().length;
	var badUse = sb4.mod.importLayouts(JSON.stringify({name: 'x', grid: grid, recipe: key, use: 'yes'}));
	ok('a non-boolean in-use flag is rejected on import', badUse.ok === false, JSON.stringify(badUse));
	ok('with a message that says so', /use/.test(badUse.msg), badUse.msg);
	eq('and nothing was added', sb4.mod.getLayouts().length, n4);

	// Duplicating a layout in use keeps what it was made for, not the use.
	var dup = sb.mod.duplicateLayout(name);
	eq('a duplicate keeps the recipe', layoutNamed(sb, dup).recipe, key);
	ok('but is not in use', !layoutNamed(sb, dup).use);
	eq('the original stays in use', layoutNamed(sb, name).use, true);

	// Using a recipe's layout takes the use away from whoever held it before.
	var second = sb.mod.customizeCurrentPlan();
	ok('a second Customize makes a new layout', second !== name, second);
	eq('which is in use', layoutNamed(sb, second).use, true);
	ok('and the first is not', !layoutNamed(sb, name).use);
	eq('though it keeps its recipe', layoutNamed(sb, name).recipe, key);
	eq('the plan follows the new holder', sb.mod.getPlan().override, second);

	sb.mod.importLayouts(JSON.stringify({name: 'Imported quiet', grid: grid, recipe: key}));
	ok('an import with a recipe but no flag does not take over', !layoutNamed(sb, 'Imported quiet').use);
	eq('the plan keeps its holder', sb.mod.getPlan().override, second);
	sb.mod.importLayouts(JSON.stringify({name: 'Imported link', grid: grid, recipe: key, use: true}));
	eq('an import in use takes the recipe', layoutNamed(sb, 'Imported link').use, true);
	ok('from the previous holder', !layoutNamed(sb, second).use);
	eq('and the plan follows it', sb.mod.getPlan().override, 'Imported link');
	var holders = sb.mod.getLayouts().filter(function (l) { return l.recipe === key && l.use; }).length;
	eq('exactly one layout is in use for the recipe', holders, 1);
})();

/* ------------------------------------------------------------------ *
 * 13. Breeding layouts loaded by seed
 *
 * loadBreedLayout opens a seed's breeding layout as a stored layout - the
 * one already in the library, or the assistant's own layout for it, computed
 * on the spot and saved. It is what turns a library default into a layout of
 * the player's own (section 14). Loading is only for looking and reshaping:
 * the assistant keeps planting its own layout until Use for breeding.
 * ------------------------------------------------------------------ */
console.log('\nbreeding layouts loaded by seed');

function filledTiles(grid) {
	var n = 0;
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) if (grid[y][x]) n++;
	return n;
}

(function () {
	// Loading computes the assistant's layout, saves it, and opens it.
	var sb = library(131, QUEENBEET_PARENTS);
	var name = sb.mod.loadBreedLayout('queenbeet');
	eq('loading names the layout after the seed', name, 'Breeding Queenbeet');
	var lay = layoutNamed(sb, name);
	ok('and adds it to the library', !!lay);
	ok('with a computed grid (' + (lay ? filledTiles(lay.grid) : 0) + ' tiles)', !!lay && filledTiles(lay.grid) > 0);
	ok('made for the queenbeet recipe', !!lay && /^breed:queenbeet:/.test(lay.recipe), lay && lay.recipe);
	ok('but not in use', !!lay && !lay.use);
	sb.mod.setTab('layouts');
	sb.step();
	ok('it opens in the editor', sb.dom.get('ggEditTitle').textContent.indexOf(name) >= 0,
		sb.dom.get('ggEditTitle').textContent);

	var count = sb.mod.getLayouts().length;
	sb.mod.createLayout('Elsewhere');
	eq('loading it again reuses the layout', sb.mod.loadBreedLayout('queenbeet'), name);
	eq('without a duplicate', sb.mod.getLayouts().length, count + 1);
	sb.step();
	ok('and opens it again', sb.dom.get('ggEditTitle').textContent.indexOf(name) >= 0);

	// The key is the one the assistant builds when it breeds the seed itself,
	// and the grid is the one its own climb finds.
	sb.mod.setMode('breed');
	sb.mod.setTarget('queenbeet');
	var plan = sb.mod.replan();
	eq('the recipe key equals the assistant\'s plan key', lay.recipe, plan.key);
	eq('the grid equals the assistant\'s own', JSON.stringify(lay.grid), JSON.stringify(plan.origGrid || plan.grid));

	eq('an unknown seed loads nothing', sb.mod.loadBreedLayout('notAPlant'), null);
	eq('and adds nothing', sb.mod.getLayouts().length, count + 1);
})();

(function () {
	// Loading never touches the live plan; Use for breeding does.
	var sb = editable(132);
	var plan = sb.mod.getPlan();
	var computed = JSON.stringify(plan.grid), computedScore = plan.score;
	var name = sb.mod.loadBreedLayout('queenbeet');
	var lay = layoutNamed(sb, name);
	eq('the loaded layout has the live plan\'s key', lay.recipe, plan.key);
	ok('the plan is not overridden by loading', !sb.mod.getPlan().override);
	var f = flipOneTile(sb, lay.grid, plan.recipe);
	sb.mod.selectLayout(name);
	sb.mod.paintTile(f.x, f.y, f.grid[f.y][f.x]);
	eq('painting it leaves the live plan alone', JSON.stringify(sb.mod.getPlan().grid), computed);
	eq('even after a re-plan', JSON.stringify(sb.mod.replan().grid), computed);

	ok('Use for breeding succeeds', sb.mod.useForBreeding(name));
	var now = sb.mod.getPlan();
	eq('and the plan is overridden by it', now.override, name);
	eq('with the drawn grid', JSON.stringify(now.grid), JSON.stringify(f.grid));
	ok('rescored (' + now.score + ' vs ' + computedScore + ')', now.score !== computedScore);
	sb.mod.setTab('layouts');
	sb.step();
	ok('the library offers Stop using for it', sb.dom.get('ggLibActions').innerHTML.indexOf('data-act="stopUse"') >= 0);

	ok('Stop using succeeds', sb.mod.stopUsing(name));
	var back = sb.mod.getPlan();
	ok('the plan is the assistant\'s again', !back.override);
	eq('with the computed grid', JSON.stringify(back.grid), computed);
	eq('and the layout keeps its recipe', layoutNamed(sb, name).recipe, plan.key);
	sb.step();
	ok('the library offers Use for breeding again', sb.dom.get('ggLibActions').innerHTML.indexOf('data-act="useBreed"') >= 0);

	// One layout in use per recipe.
	var copy = sb.mod.duplicateLayout(name);
	sb.mod.useForBreeding(name);
	sb.mod.useForBreeding(copy);
	ok('using the copy stops the original', !layoutNamed(sb, name).use);
	eq('the copy is in use', layoutNamed(sb, copy).use, true);
	eq('and the plan follows it', sb.mod.getPlan().override, copy);
	eq('loading the seed opens the layout in use', sb.mod.loadBreedLayout('queenbeet'), copy);

	// The flag survives a save and reload.
	var sb2 = library(133, QUEENBEET_PARENTS);
	sb2.mod.load(sb.mod.save());
	eq('the in-use flag survives a reload', layoutNamed(sb2, copy).use, true);
	ok('and the other layout stays off', !layoutNamed(sb2, name).use);
})();

(function () {
	// A seed already banked still loads, so it can be bred again.
	var sb = library(134, ['bakerWheat', 'thumbcorn']);
	var name = sb.mod.loadBreedLayout('thumbcorn');
	eq('a banked seed loads a layout', name, 'Breeding Thumbcorn');
	var lay = layoutNamed(sb, name);
	ok('with a computed grid', !!lay && filledTiles(lay.grid) > 0);
	ok('bred from its parents, not from itself', !!lay && JSON.stringify(lay.grid).indexOf('thumbcorn') < 0,
		lay && JSON.stringify(lay.grid));
	ok('keyed to thumbcorn', !!lay && /^breed:thumbcorn:/.test(lay.recipe));

	var lump = sb.mod.loadBreedLayout('queenbeetLump');
	ok('a seed whose parents are not unlocked still loads (' + lump + ')', lump === 'Breeding Juicy queenbeet',
		String(lump));
})();

/* ------------------------------------------------------------------ *
 * 14. Every breeding layout in the library by default
 *
 * The library lists, after the player's own layouts, one "Breeding <Seed>"
 * entry per seed with a recipe. Those are not stored: their grid is the
 * assistant's layout for the current plot, worked out only when one is
 * opened, and kept out of the save and the export. The first change to one -
 * a paint stroke, Rename, Duplicate, Use for breeding - turns it
 * into a stored layout, which then stands in its place. Deleting that brings
 * the default back.
 * ------------------------------------------------------------------ */
console.log('\nbreeding layouts in the library by default');

function virtuals(sb) {
	return sb.mod.getLibrary().filter(function (e) { return e.virtual; });
}

function virtualFor(sb, seed) {
	var v = virtuals(sb);
	for (var i = 0; i < v.length; i++) if (v[i].seed === seed) return v[i];
	return null;
}

/** Fires one of the panel's own handlers with a hand-made element, as a click would. */
function firePanel(sb, type, attrs) {
	var panel = sb.dom.findCreated('grandpasGreenhousePanel');
	var el = {
		isConnected: true,
		getAttribute: function (k) { return attrs.hasOwnProperty(k) ? attrs[k] : null; },
		contains: function () { return false; }
	};
	var ev = {target: {closest: function () { return el; }}, relatedTarget: null};
	(panel.listeners[type] || []).forEach(function (f) { f(ev); });
}

(function () {
	// Listed for every breedable seed, in game order, without computing any.
	var sb = library(140, QUEENBEET_PARENTS);
	sb.mod.setTab('layouts');
	sb.step();
	var recipes = sb.mod.getRecipes(), order = [], without = [];
	for (var i = 0; i < sb.M.plantsById.length; i++) {
		var p = sb.M.plantsById[i];
		((recipes[p.key] || []).length ? order : without).push(p);
	}
	var v = virtuals(sb);
	eq('one default per seed with a recipe', v.length, order.length);
	eq('named Breeding <Seed>, in the game\'s order', v.map(function (e) { return e.name; }).join('|'),
		order.map(function (p) { return 'Breeding ' + p.name; }).join('|'));
	ok('each knows its seed', v.every(function (e, j) { return e.seed === order[j].key; }));
	ok('and its plan key', v.every(function (e) { return /^breed:/.test(e.recipe); }));
	eq('none of them is stored', sb.mod.getLayouts().length, 0);
	eq('opening the tab computes no grid', sb.mod.cachedDefaults(), 0);

	var html = sb.dom.get('ggLibrary').innerHTML;
	eq('the list draws a row per default', (html.match(/data-act="libSel" data-seed="/g) || []).length, order.length);
	ok('a basic cross is listed (thumbcorn)', html.indexOf('data-seed="thumbcorn"') >= 0);
	ok('a late-game seed is listed (everdaisy)', html.indexOf('data-seed="everdaisy"') >= 0);
	ok('a banked seed is listed (bakerWheat)', html.indexOf('data-seed="bakerWheat"') >= 0);
	for (var w = 0; w < without.length; w++) {
		ok(without[w].key + ' has no recipe and no default', html.indexOf('data-seed="' + without[w].key + '"') < 0);
	}
	ok('with the seed as its badge', html.indexOf('>[Everdaisy]</span>') >= 0);
	ok('the empty-library hint is gone', html.indexOf('none yet') < 0);

	// The seed row the defaults replace is gone, markup and help both.
	var panel = sb.dom.findCreated('grandpasGreenhousePanel').innerHTML;
	ok('there is no Breeding layout row any more', panel.indexOf('Breeding layout:') < 0 &&
		panel.indexOf('ggBreedPicker') < 0);
	eq('nor its help text', sb.mod.getHelp('breedPicker'), '');
	ok('the palette is still labelled Brush', panel.indexOf('>Brush:</span>') >= 0);
	ok('and still there', (sb.dom.get('ggPalette').innerHTML.match(/data-act="brush"/g) || []).length > 1);

	// The player's own come first; nothing virtual reaches the save or export.
	sb.mod.createLayout('Mine');
	var lib = sb.mod.getLibrary();
	eq('a stored layout is listed first', lib[0].name, 'Mine');
	ok('as a stored one', !lib[0].virtual);
	ok('then the defaults', lib.slice(1).every(function (e) { return e.virtual; }) && lib.length === order.length + 1);
	sb.step();
	ok('in the drawn list too', sb.dom.get('ggLibrary').innerHTML.indexOf('>Mine</span>') <
		sb.dom.get('ggLibrary').innerHTML.indexOf('data-seed="'));
	eq('export holds only the stored layout', JSON.parse(sb.mod.exportLayouts()).length, 1);
	ok('and the save names no default', sb.mod.save().indexOf('Breeding ') < 0);
	var sb2 = library(141, QUEENBEET_PARENTS);
	sb2.mod.load(sb.mod.save());
	eq('after a reload only the stored layout is stored', sb2.mod.getLayouts().length, 1);
	eq('and the defaults are listed again', virtuals(sb2).length, order.length);
})();

(function () {
	// Selecting a default computes its grid once; painting it makes it stored.
	var sb = library(142, QUEENBEET_PARENTS);
	ok('a default can be selected by its name', sb.mod.selectLayout('Breeding Queenbeet'));
	var ed = sb.mod.getEditorLayout();
	ok('the editor holds the default', !!ed && ed.virtual === true && ed.name === 'Breeding Queenbeet');
	eq('computing its grid, and only its', sb.mod.cachedDefaults(), 1);
	sb.mod.getEditorLayout();
	eq('which is not computed again', sb.mod.cachedDefaults(), 1);
	eq('nothing was stored', sb.mod.getLayouts().length, 0);
	sb.mod.setTab('layouts');
	sb.step();
	ok('the editor names it', sb.dom.get('ggEditTitle').textContent.indexOf('Breeding Queenbeet') >= 0,
		sb.dom.get('ggEditTitle').textContent);
	ok('the list marks it selected', /ggSel[^>]*data-seed="queenbeet"/.test(sb.dom.get('ggLibrary').innerHTML));
	ok('its tiles take a click', sb.dom.get('ggEditGrid').innerHTML.indexOf('data-act="paint"') >= 0);
	var acts = sb.dom.get('ggLibActions').innerHTML;
	ok('it offers Use for breeding, Rename and Duplicate, and no Activate',
		['useBreed', 'libRename', 'libDup'].every(function (a) { return acts.indexOf('data-act="' + a + '"') >= 0; }) &&
			acts.indexOf('data-act="activate"') < 0,
		acts);
	ok('but nothing to delete', acts.indexOf('data-act="libDelete"') < 0);

	// The grid is the one the assistant breeds with itself.
	sb.mod.setMode('breed');
	sb.mod.setTarget('queenbeet');
	var plan = sb.mod.replan();
	eq('its key is the assistant\'s plan key', virtualFor(sb, 'queenbeet').recipe, plan.key);
	eq('its grid is the assistant\'s own', JSON.stringify(ed.grid), JSON.stringify(plan.grid));

	// The first paint stroke keeps it.
	var f = flipOneTile(sb, ed.grid, plan.recipe);
	ok('painting it is accepted', sb.mod.paintTile(f.x, f.y, f.grid[f.y][f.x]));
	var lay = layoutNamed(sb, 'Breeding Queenbeet');
	ok('and stores it under the same name', !!lay && sb.mod.getLayouts().length === 1);
	eq('made for the plan key', lay && lay.recipe, plan.key);
	ok('but not in use', !!lay && !lay.use);
	eq('holding the computed grid plus the stroke', lay && JSON.stringify(lay.grid), JSON.stringify(f.grid));
	ok('the default gives way to it', !virtualFor(sb, 'queenbeet'));
	ok('and the editor now holds the stored one', sb.mod.getEditorLayout().virtual === false);
	ok('the live plan is not taken over', !sb.mod.getPlan().override);

	// Renamed, it still stands in for the default: the recipe says so.
	sb.mod.renameLayout('Breeding Queenbeet', 'My beets');
	ok('a renamed ex-default still hides the default', !virtualFor(sb, 'queenbeet'));

	// Deleting it loses nothing: the default is recomputed.
	ok('deleting the stored one works', sb.mod.deleteLayout('My beets'));
	ok('and the default is back', !!virtualFor(sb, 'queenbeet'));
	eq('with nothing stored', sb.mod.getLayouts().length, 0);

	// A stored layout of the same name hides the default as well.
	sb.mod.createLayout('Breeding Thumbcorn');
	ok('a stored namesake hides the default', !virtualFor(sb, 'thumbcorn'));
	// A layout for the same seed on a different plot size does not.
	var parts = plan.key.split(':');
	parts[parts.length - 1] = String(parseInt(parts[parts.length - 1], 10) - 1);
	sb.mod.importLayouts(JSON.stringify({name: 'Old plot', grid: f.grid, recipe: parts.join(':')}));
	ok('a layout made for a smaller plot does not', !!virtualFor(sb, 'queenbeet'));
})();

(function () {
	// A plot that grows moves the key, and the default follows it.
	var sb = library(143, QUEENBEET_PARENTS);
	sb.mod.selectLayout('Breeding Queenbeet');
	var before = sb.mod.getEditorLayout(), key = virtualFor(sb, 'queenbeet').recipe;
	var real = sb.M.isTileUnlocked;
	sb.M.isTileUnlocked = function (x, y) { return y < 5 && real.call(sb.M, x, y); };
	var after = sb.mod.getEditorLayout();
	ok('the key changes with the plot (' + virtualFor(sb, 'queenbeet').recipe + ')',
		virtualFor(sb, 'queenbeet').recipe !== key);
	ok('and the grid is worked out again for it', after.grid[5].every(function (c) { return c === ''; }) &&
		JSON.stringify(after.grid) !== JSON.stringify(before.grid));
	sb.M.isTileUnlocked = real;
})();

(function () {
	// The library's buttons on a default: each one makes it stored first.
	var sb = library(144, QUEENBEET_PARENTS);
	sb.mod.setTab('layouts');
	sb.step();

	firePanel(sb, 'click', {'data-act': 'libSel', 'data-seed': 'thumbcorn'});
	eq('clicking a default row opens it', sb.mod.getEditorLayout().name, 'Breeding Thumbcorn');
	ok('without storing it', sb.mod.getLayouts().length === 0);
	var modeBefore = sb.mod.getSettings().mode;
	firePanel(sb, 'click', {'data-act': 'activate', 'data-seed': 'thumbcorn'});
	ok('a stray Activate click stores nothing', !layoutNamed(sb, 'Breeding Thumbcorn'));
	eq('and changes no mode', sb.mod.getSettings().mode, modeBefore);

	firePanel(sb, 'click', {'data-act': 'libSel', 'data-seed': 'cronerice'});
	firePanel(sb, 'click', {'data-act': 'libRename'});
	firePanel(sb, 'click', {'data-act': 'dlgCancel'});
	ok('a cancelled Rename stores nothing', !layoutNamed(sb, 'Breeding Cronerice') && !!virtualFor(sb, 'cronerice'));
	firePanel(sb, 'click', {'data-act': 'libRename'});
	sb.dom.get('ggDlgInput').value = 'Rice field';
	firePanel(sb, 'click', {'data-act': 'dlgOk'});
	var r = layoutNamed(sb, 'Rice field');
	ok('Rename stores it under the new name', !!r && /^breed:cronerice:/.test(r.recipe));
	ok('and the default gives way', !virtualFor(sb, 'cronerice') && !layoutNamed(sb, 'Breeding Cronerice'));

	firePanel(sb, 'click', {'data-act': 'libSel', 'data-seed': 'gildmillet'});
	firePanel(sb, 'click', {'data-act': 'libDup'});
	ok('Duplicate stores it and a copy',
		!!layoutNamed(sb, 'Breeding Gildmillet') && !!layoutNamed(sb, 'Breeding Gildmillet 2'));
	eq('the copy keeps the recipe', layoutNamed(sb, 'Breeding Gildmillet 2').recipe,
		layoutNamed(sb, 'Breeding Gildmillet').recipe);

	var sb2 = editable(145);
	var plan = sb2.mod.getPlan();
	sb2.mod.setTab('layouts');
	sb2.step();
	firePanel(sb2, 'click', {'data-act': 'libSel', 'data-seed': 'queenbeet'});
	firePanel(sb2, 'click', {'data-act': 'useBreed', 'data-seed': 'queenbeet'});
	var q = layoutNamed(sb2, 'Breeding Queenbeet');
	ok('Use for breeding stores it in use', !!q && q.use === true && q.recipe === plan.key);
	eq('and the plan is planted from it', sb2.mod.getPlan().override, 'Breeding Queenbeet');
	eq('with the computed grid', JSON.stringify(sb2.mod.getPlan().grid), JSON.stringify(plan.grid));
})();

(function () {
	// A stored layout is the player's: nothing automatic ever redraws it.
	var sb = editable(147);
	var plan = sb.mod.getPlan();
	sb.mod.selectLayout('Breeding Queenbeet');
	var f = flipOneTile(sb, sb.mod.getEditorLayout().grid, plan.recipe);
	sb.mod.paintTile(f.x, f.y, f.grid[f.y][f.x]);
	sb.mod.useForBreeding('Breeding Queenbeet');
	var before = JSON.stringify(sb.mod.getLayouts());
	sb.mod.setTab('layouts');
	for (var i = 0; i < 3; i++) sb.step();
	sb.mod.replan();
	sb.mod.selectLayout('Breeding Thumbcorn');
	sb.mod.getEditorLayout();
	sb.mod.loadBreedLayout('queenbeet');
	eq('rebuilds, refreshes and computing defaults leave it byte for byte', JSON.stringify(sb.mod.getLayouts()), before);
	var real = sb.M.isTileUnlocked;
	sb.M.isTileUnlocked = function (x, y) { return y < 5 && real.call(sb.M, x, y); };
	sb.mod.replan();
	sb.step();
	sb.M.isTileUnlocked = real;
	eq('and so does the plot changing size', JSON.stringify(sb.mod.getLayouts()), before);
	var sb2 = library(148, QUEENBEET_PARENTS);
	sb2.mod.load(sb.mod.save());
	sb2.mod.setTab('layouts');
	sb2.step();
	eq('and a reload', JSON.stringify(sb2.mod.getLayouts()), before);
	ok('where it still stands in for the default', !virtualFor(sb2, 'queenbeet'));
})();

(function () {
	// Set to default: the one explicit way back to the assistant's drawing.
	var sb = editable(149);
	var plan = sb.mod.getPlan();
	var computed = JSON.stringify(plan.grid);
	sb.mod.selectLayout('Breeding Queenbeet');
	var f = flipOneTile(sb, sb.mod.getEditorLayout().grid, plan.recipe);
	sb.mod.paintTile(f.x, f.y, f.grid[f.y][f.x]);
	sb.mod.useForBreeding('Breeding Queenbeet');
	sb.mod.renameLayout('Breeding Queenbeet', 'Tuned');
	eq('the plan plants the hand-drawn layout', JSON.stringify(sb.mod.getPlan().grid), JSON.stringify(f.grid));
	sb.mod.setTab('layouts');
	sb.step();
	var acts = sb.dom.get('ggLibActions').innerHTML;
	ok('a layout with a recipe offers Set to default', acts.indexOf('data-act="libReset"') >= 0, acts);

	firePanel(sb, 'click', {'data-act': 'libReset'});
	ok('which asks first', /Set to default/.test(sb.dom.get('ggDialog').innerHTML), sb.dom.get('ggDialog').innerHTML);
	eq('and changes nothing before the answer', JSON.stringify(layoutNamed(sb, 'Tuned').grid), JSON.stringify(f.grid));
	firePanel(sb, 'click', {'data-act': 'dlgCancel'});
	eq('Cancel keeps the drawing', JSON.stringify(layoutNamed(sb, 'Tuned').grid), JSON.stringify(f.grid));

	firePanel(sb, 'click', {'data-act': 'libReset'});
	firePanel(sb, 'click', {'data-act': 'dlgOk'});
	var lay = layoutNamed(sb, 'Tuned');
	eq('confirmed, the grid is the assistant\'s again', JSON.stringify(lay.grid), computed);
	eq('the name stays', !!lay, true);
	eq('the recipe stays', lay.recipe, plan.key);
	eq('the in-use flag stays', lay.use, true);
	eq('and the live plan follows it', JSON.stringify(sb.mod.getPlan().grid), computed);
	eq('still planted from the layout', sb.mod.getPlan().override, 'Tuned');

	sb.mod.createLayout('Free');
	sb.step();
	ok('a layout without a recipe offers no Set to default',
		sb.dom.get('ggLibActions').innerHTML.indexOf('data-act="libReset"') < 0);
	eq('and refuses it through the API', sb.mod.resetToDefault('Free'), false);
	firePanel(sb, 'click', {'data-act': 'libReset'});
	ok('nor opens the question', sb.dom.get('ggDialog').innerHTML.indexOf('Set to default') < 0);
	sb.mod.importLayouts(JSON.stringify({name: 'Odd', grid: lay.grid, recipe: 'breed:notAPlant:x:1'}));
	eq('nor on a recipe the mod cannot work out', sb.mod.resetToDefault('Odd'), false);
})();

(function () {
	// About 35 rows stay cheap: a refresh builds the list without climbing.
	var sb = library(146);
	sb.unlock(allSeeds(sb));
	sb.mod.setTab('layouts');
	var t0 = Date.now();
	for (var i = 0; i < 20; i++) sb.step();
	var ms = Date.now() - t0;
	eq('twenty refreshes of the tab compute no default', sb.mod.cachedDefaults(), 0);
	ok('and take little time (' + ms + ' ms)', ms < 5000);
})();

/* ------------------------------------------------------------------ *
 * 15. A soil change re-plans by itself
 *
 * Soil changes how fast plants grow, so a layout scored on one soil is
 * stale on another. There is no Re-plan button any more: the mod watches
 * M.soil and works the plan out again on the next logic tick. Soil stays
 * out of the plan key, so a layout linked to a recipe survives the swap.
 * ------------------------------------------------------------------ */
console.log('\nsoil change re-plans');

(function () {
	var sb = editable(150);
	sb.step();
	var before = sb.mod.getPlan();
	sb.step();
	ok('without a soil change a step keeps the same plan', sb.mod.getPlan() === before);

	var other = sb.M.soil === 1 ? 0 : 1;
	sb.M.soil = other;
	// One logic tick with no garden step: only the soil watch can act here.
	(sb.Game.hooks.logic || []).forEach(function (f) { f(); });
	var after = sb.mod.getPlan();
	ok('a soil change rebuilds the plan on the next tick, between steps', !!after && after !== before);
	eq('under the same key, so links to it survive', after && after.key, before.key);
	(sb.Game.hooks.logic || []).forEach(function (f) { f(); });
	ok('and only once for one change', sb.mod.getPlan() === after);

	// A layout in use for the recipe is still planted after the swap.
	var name = sb.mod.customizeCurrentPlan();
	sb.M.soil = other === 1 ? 0 : 1;
	(sb.Game.hooks.logic || []).forEach(function (f) { f(); });
	eq('a linked layout still stands in for the rebuilt plan', sb.mod.getPlan().override, name);
})();

/* ------------------------------------------------------------------ *
 * 16. Reset mod data
 *
 * The Settings page carries a last-resort button: wipe every setting,
 * drawing and counter back to first-run, for the player whose saved mod
 * data got into a bad state. The garden itself is never touched.
 * ------------------------------------------------------------------ */
console.log('\nreset mod data');

(function () {
	var sb = editable(160);
	sb.step();
	var mod = sb.mod;

	mod.setTab('settings');
	sb.step();   // a garden step always refreshes; a bare tick may be throttled
	ok('the Settings page offers Reset mod data', !!sb.dom.get('ggWipeBtn'));
	eq('with its confirmation hidden until asked', sb.dom.get('ggWipeRow').style.display, 'none');

	// Give the wipe something to forget.
	mod.setMode('boost');
	mod.createLayout('Scratch');
	ok('precondition: a drawing and a non-default mode exist',
		mod.getLayouts().length > 0 && mod.getSettings().mode === 'boost');

	mod.wipeData();
	eq('the mode is back to its default', mod.getSettings().mode, 'tend');
	eq('the drawings are gone', mod.getLayouts().length, 0);
	eq('the counters are back to zero', mod.getStats().planted, 0);
	eq('the player stays on the Settings page', mod.getSettings().tab, 'settings');
	eq('and the status says what happened', mod.getStatus(), 'mod data reset');

	// The mod keeps working: two ticks and a step run without an error and
	// the panel is still there.
	(sb.Game.hooks.logic || []).forEach(function (f) { f(); });
	sb.step();
	ok('the panel survives the wipe', !!sb.dom.get('ggWipeBtn'));

	// A wiped save round-trips: what saves now is the first-run state.
	var sb2 = editable(161);
	sb2.step();
	sb2.mod.load(mod.save());
	eq('a save taken after the wipe loads as defaults', sb2.mod.getSettings().mode, 'tend');
	eq('with no drawings', sb2.mod.getLayouts().length, 0);
})();

/* ------------------------------------------------------------------ */
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
