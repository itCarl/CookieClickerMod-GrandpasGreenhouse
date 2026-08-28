/**
 * Does the assistant's layout match what the community recommends?
 *
 *   node layouts.js
 *
 * The hand-drawn garden guides all boil down to a handful of shapes:
 * a checkerboard, alternating rows or columns, and - for the recipes that want
 * many of one parent at once - a solid block with single-tile holes so every
 * hole is surrounded by eight plants.
 *
 * Those shapes are rebuilt here and scored with the same function the mod uses,
 * which is the game's own M.getMuts. So this is not "do the pictures look
 * alike" but "does either shape actually breed more", answered in expected
 * mutations per garden step.
 */
'use strict';

var boot = require('./garden.js').boot;

var sb = boot({seed: 1, level: 9, cookies: 1e30, cookiesPs: 1});
var mod = sb.loadMod();
var M = sb.M;

function unlockedTiles() {
	var out = [];
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) if (M.isTileUnlocked(x, y)) out.push([x, y]);
	return out;
}

function emptyGrid() {
	var g = [];
	for (var y = 0; y < 6; y++) { g[y] = []; for (var x = 0; x < 6; x++) g[y][x] = ''; }
	return g;
}

/**
 * The exact chance a target lands on one empty tile, including the fact that
 * the game plants only one winner chosen uniformly from every roll that passed.
 * Same maths as the mod - see landChance in main.js.
 */
function landChance(muts, target) {
	var pT = 0, others = [];
	for (var i = 0; i < muts.length; i++) {
		if (muts[i][0] === target) pT = 1 - (1 - pT) * (1 - muts[i][1]);
		else others.push(muts[i][1]);
	}
	if (pT <= 0) return 0;
	var dist = [1];
	for (var i = 0; i < others.length; i++) {
		var p = others[i], next = [];
		for (var k = 0; k <= dist.length; k++) next[k] = 0;
		for (var k = 0; k < dist.length; k++) {
			next[k] += dist[k] * (1 - p);
			next[k + 1] += dist[k] * p;
		}
		dist = next;
	}
	var share = 0;
	for (var k = 0; k < dist.length; k++) share += dist[k] / (1 + k);
	return pT * share;
}

function score(grid, target) {
	var total = 0;
	for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) {
		if (!M.isTileUnlocked(x, y) || grid[y][x]) continue;
		var neighs = {}, neighsM = {}, any = 0;
		for (var k in M.plants) { neighs[k] = 0; neighsM[k] = 0; }
		for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			var nx = x + dx, ny = y + dy;
			if (nx < 0 || nx > 5 || ny < 0 || ny > 5 || !M.isTileUnlocked(nx, ny)) continue;
			if (!grid[ny][nx]) continue;
			any++; neighs[grid[ny][nx]]++; neighsM[grid[ny][nx]]++;
		}
		if (any) total += landChance(M.getMuts(neighs, neighsM), target);
	}
	return total;
}

/* --- the shapes the community guides draw ------------------------------- */

function fill(pred, species) {
	var g = emptyGrid(), alt = 0;
	unlockedTiles().forEach(function (t) {
		var x = t[0], y = t[1];
		if (!pred(x, y)) return;
		g[y][x] = species.length > 1 ? species[alt++ % species.length] : species[0];
	});
	return g;
}

var SHAPES = {
	'checkerboard':      function (s) { return fill(function (x, y) { return (x + y) % 2 === 0; }, s); },
	'alternating rows':  function (s) { return fill(function (x, y) { return y % 2 === 0; }, s); },
	'alternating cols':  function (s) { return fill(function (x, y) { return x % 2 === 0; }, s); },
	'solid, holes 3x3':  function (s) { return fill(function (x, y) { return !(x % 3 === 1 && y % 3 === 1); }, s); },
	'solid, holes 2x2':  function (s) { return fill(function (x, y) { return !(x % 2 === 1 && y % 2 === 1); }, s); },
	'two rows, one gap': function (s) { return fill(function (x, y) { return y % 3 !== 2; }, s); },
	'full plot':         function (s) { return fill(function () { return true; }, s); },

	// Shapes read off the community chart itself (the Reddit "garden mutation
	// setup for all garden sizes" post), rather than generic ones.
	'ring (chart)':      function (s) {
		return fill(function (x, y) {
			var border = (x === 0 || x === 5 || y === 0 || y === 5);
			var centre = (x >= 2 && x <= 3 && y >= 2 && y <= 3);
			return border || centre;
		}, s);
	},
	'paired blocks (chart)': function (s) {
		// Two-wide blocks of plants with a gap column, banded with empty rows.
		return fill(function (x, y) { return (x % 3 !== 2) && (y % 3 !== 2); }, s);
	},
	'solid, 4 holes (chart)': function (s) {
		return fill(function (x, y) {
			return !((x === 1 || x === 4) && (y === 1 || y === 4));
		}, s);
	}
};

/** Two parents laid out so each is adjacent to the same holes. */
function pairShapes(a, b) {
	return {
		'checkerboard, alternating':  fill(function (x, y) { return (x + y) % 2 === 0; }, [a, b]),
		'rows of a, rows of b':       (function () {
			var g = emptyGrid();
			unlockedTiles().forEach(function (t) {
				var x = t[0], y = t[1];
				if (y % 3 === 2) return;
				g[y][x] = (y % 3 === 0) ? a : b;
			});
			return g;
		})(),
		'columns of a, columns of b': (function () {
			var g = emptyGrid();
			unlockedTiles().forEach(function (t) {
				var x = t[0], y = t[1];
				if (x % 3 === 2) return;
				g[y][x] = (x % 3 === 0) ? a : b;
			});
			return g;
		})(),
		'solid, holes 3x3':           fill(function (x, y) { return !(x % 3 === 1 && y % 3 === 1); }, [a, b]),
		// The chart's two-variety 6x6: paired blocks of the two parents.
		'paired blocks (chart)':      fill(function (x, y) { return (x % 3 !== 2) && (y % 3 !== 2); }, [a, b]),
		'stripes, alternating pairs': (function () {
			var g = emptyGrid();
			unlockedTiles().forEach(function (t) {
				var x = t[0], y = t[1];
				if (x % 3 === 2) return;
				g[y][x] = ((x + y) % 2 === 0) ? a : b;
			});
			return g;
		})()
	};
}

function render(grid) {
	var seen = {}, order = [], lines = [];
	for (var y = 0; y < 6; y++) {
		var row = '';
		for (var x = 0; x < 6; x++) {
			if (!M.isTileUnlocked(x, y)) { row += '  '; continue; }
			var k = grid[y][x];
			if (!k) { row += ' .'; continue; }
			if (!seen[k]) { seen[k] = String.fromCharCode(65 + order.length); order.push(k); }
			row += ' ' + seen[k];
		}
		lines.push(row);
	}
	return {lines: lines, key: order.map(function (k) { return seen[k] + '=' + M.plants[k].name; }).join('  ')};
}

/* --- the comparison ----------------------------------------------------- */

var CASES = [
	{target: 'bakeberry',      unlock: ['bakerWheat'],                       label: 'Bakeberry (2x Baker\'s wheat)'},
	{target: 'queenbeet',      unlock: ['bakerWheat','chocoroot','bakeberry'], label: 'Queenbeet (chocoroot + bakeberry)'},
	{target: 'queenbeetLump',  unlock: ['queenbeet'],                        label: 'Juicy queenbeet (8x queenbeet)'},
	{target: 'goldenClover',   unlock: ['clover'],                           label: 'Golden clover (4x clover)'},
	{target: 'shriekbulb',     unlock: ['elderwort'],                        label: 'Shriekbulb (5x elderwort)'},
	{target: 'everdaisy',      unlock: ['tidygrass','elderwort'],            label: 'Everdaisy (3x tidygrass + 3x elderwort)'}
];

var wins = 0, ties = 0, losses = 0;

CASES.forEach(function (C) {
	// Only the parents are known, and the target itself stays locked so the
	// assistant is willing to work towards it.
	for (var k in M.plants) M.plants[k].unlocked = 0;
	C.unlock.forEach(function (k) { M.plants[k].unlocked = 1; });
	M.getUnlockedN();

	mod.setMode('breed');
	mod.setTarget(C.target);
	var plan = mod.replan();
	if (!plan || !plan.grid) { console.log('\n' + C.label + ': the assistant has no route'); return; }

	var mine = score(plan.grid, C.target);
	var parents = [];
	plan.recipe.parents.forEach(function (p) { parents.push(p.key); });

	var candidates = {};
	if (parents.length === 1) {
		for (var name in SHAPES) candidates[name] = SHAPES[name]([parents[0]]);
	} else {
		var ps = pairShapes(parents[0], parents[1]);
		for (var name2 in ps) candidates[name2] = ps[name2];
	}

	var bestName = null, bestScore = -1;
	for (var n in candidates) {
		var sc = score(candidates[n], C.target);
		if (sc > bestScore) { bestScore = sc; bestName = n; }
	}

	console.log('\n' + C.label);
	console.log('  best hand-drawn shape   ' + bestName.padEnd(26) + bestScore.toFixed(4) + ' per step');
	console.log('  the assistant           ' + ''.padEnd(26) + mine.toFixed(4) + ' per step');
	var diff = bestScore > 0 ? (mine / bestScore - 1) * 100 : 0;
	var verdict;
	if (mine > bestScore * 1.005) { verdict = 'assistant is better by ' + diff.toFixed(1) + '%'; wins++; }
	else if (mine > bestScore * 0.995) { verdict = 'the same layout, effectively'; ties++; }
	else { verdict = 'WORSE by ' + (-diff).toFixed(1) + '%'; losses++; }
	console.log('  ->                      ' + verdict);

	var r = render(plan.grid);
	console.log('  what it plants:   ' + r.key);
	r.lines.forEach(function (l) { console.log('        ' + l); });
	var rb = render(candidates[bestName]);
	console.log('  the hand-drawn one:');
	rb.lines.forEach(function (l) { console.log('        ' + l); });
});

console.log('\n' + wins + ' better, ' + ties + ' equal, ' + losses + ' worse than the best hand-drawn shape.');
console.log('');
