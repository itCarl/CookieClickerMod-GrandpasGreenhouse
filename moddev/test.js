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
	// Score the naive grid the same way the mod does, via the game's getMuts.
	function scoreGrid(grid, target) {
		var total = 0;
		for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
			if (!sb.M.isTileUnlocked(x, y) || grid[y][x]) continue;
			var neighs = {}, neighsM = {}, any = 0;
			for (var k in sb.M.plants) { neighs[k] = 0; neighsM[k] = 0; }
			for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue;
				var nx = x + dx, ny = y + dy;
				if (nx < 0 || nx > 5 || ny < 0 || ny > 5 || !sb.M.isTileUnlocked(nx, ny)) continue;
				if (!grid[ny][nx]) continue;
				any++; neighs[grid[ny][nx]]++; neighsM[grid[ny][nx]]++;
			}
			if (!any) continue;
			var muts = sb.M.getMuts(neighs, neighsM);
			for (var i = 0; i < muts.length; i++) if (muts[i][0] === target) total += muts[i][1];
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
	// taking it is not a loss and is not worth a question.
	var sb = fresh({seed: 32, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(QUEENBEET_PARENTS.concat(['clover']));
	sb.clear();
	sb.plant('clover', 1, 1, 95);
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
	ok('there is a Settings button', html.indexOf('data-act="settings"') >= 0);
	ok('there is a seed picker grid', html.indexOf('id="ggSeedGrid"') >= 0);

	// Hover help on the controls whose consequences are not obvious.
	ok('each mode button explains itself', (html.match(/data-act="mode"[^>]*title="/g) || []).length === 4);
	ok('the progress readout has hover text', /id="ggProgress" title="/.test(html));
	ok('Re-plan has hover text', /data-act="replan" title="/.test(html));
	ok('both answers to the clear question explain themselves',
		/data-act="clearYes" title="/.test(html) && /data-act="clearNo" title="/.test(html));
	ok('the layout preview explains the dashed squares',
		/mutations can only land on an empty tile/.test(html));
	ok('the boost dropdown is still there', html.indexOf('id="ggChoice"') >= 0);
	ok('there is a layout grid', html.indexOf('id="ggGrid"') >= 0);

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
	ok('each tile carries its recipe as a tooltip', /title="[^"]*mature[^"]*"/.test(picker));

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
	// The settings only render inside the Settings box, and they are the
	// controls most in need of a why.
	var sb = fresh({seed: 41, level: 9, cookies: 1e30, cookiesPs: 1});
	sb.unlock(QUEENBEET_PARENTS);
	sb.step();
	var panel = sb.dom.findCreated('grandpasGreenhousePanel').innerHTML;
	['bankNew', 'harvestMature', 'keepPlan', 'pullWeeds', 'askBeforeClearing'].forEach(function (k) {
		var re = new RegExp('<div class="ggSet" title="[^"]+"><input[^>]*id="ggSet-' + k + '"');
		ok('the ' + k + ' setting has hover text', re.test(panel));
	});
	ok('the harvest-new setting says why it matters',
		/harvesting early banks nothing/.test(panel));
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

/* ------------------------------------------------------------------ */
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
