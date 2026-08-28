/**
 * Discovery benchmark: how many of the 34 species does the assistant unlock,
 * unattended, starting from a fresh save that knows only Baker's wheat?
 *
 *   node bench.js [steps] [seeds]
 *
 * Runs against the game's own growth and mutation code via garden.js, so the
 * only thing being measured is the assistant's choices.
 */
'use strict';

var boot = require('./garden.js').boot;

var STEPS = parseInt(process.argv[2], 10) || 3000;
var SEEDS = parseInt(process.argv[3], 10) || 3;

function run(seed, mode) {
	var sb = boot({seed: seed, level: 9, cookies: 1e40, cookiesPs: 1});
	var mod = sb.loadMod();
	sb.clear();
	for (var k in sb.M.plants) sb.M.plants[k].unlocked = 0;
	sb.M.plants['bakerWheat'].unlocked = 1;
	sb.M.getUnlockedN();

	mod.setMode(mode);
	mod.setTarget('');

	var marks = {}, milestones = [5, 10, 15, 20, 25, 30];
	for (var i = 0; i < STEPS; i++) {
		sb.step();
		var n = sb.unlockedCount();
		for (var mi = 0; mi < milestones.length; mi++) {
			if (n >= milestones[mi] && !marks[milestones[mi]]) marks[milestones[mi]] = i + 1;
		}
	}
	return {found: sb.unlockedCount(), marks: marks};
}

console.log(STEPS + ' garden steps, ' + SEEDS + ' seeds, farm level 9, starting from Baker\'s wheat only\n');

['tend', 'breed'].forEach(function (mode) {
	var total = 0, per = [], allMarks = {};
	for (var s = 1; s <= SEEDS; s++) {
		var r = run(s, mode);
		total += r.found;
		per.push(r.found);
		for (var k in r.marks) (allMarks[k] || (allMarks[k] = [])).push(r.marks[k]);
	}
	console.log(mode.toUpperCase() + '  average ' + (total / SEEDS).toFixed(1) +
		' of 34   (per seed: ' + per.join(', ') + ')');
	var line = [];
	[5, 10, 15, 20, 25, 30].forEach(function (m) {
		var hits = allMarks[m] || [];
		if (hits.length === SEEDS) {
			var avg = hits.reduce(function (a, b) { return a + b; }, 0) / hits.length;
			line.push(m + ' by step ' + Math.round(avg));
		}
	});
	if (line.length) console.log('        ' + line.join(',  '));
	console.log('');
});
