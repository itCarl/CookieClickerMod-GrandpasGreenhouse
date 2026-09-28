/**
 * How much of its life does each plant spend mature?
 *
 *   node odds.js
 *
 * A recipe reads neighsM, which counts only neighbours past their own mature
 * age, so this share is what a neighbour is actually worth to a layout. The
 * numbers come from the mod itself (getMatureOdds), off the game's own plant
 * data - nothing here is transcribed.
 */
'use strict';

var sb = require('./garden.js').boot({seed: 1, level: 9});
var mod = sb.loadMod();
sb.step();                                     // let the mod wake up

var rows = [];
for (var k in sb.M.plants) {
	var p = sb.M.plants[k];
	rows.push({
		name:   p.name,
		mature: p.mature,
		steps:  p.mature / (p.ageTick + p.ageTickR / 2),
		odds:   mod.getMatureOdds(k),
		note:   p.immortal ? 'immortal - grown is forever' : (p.weed ? 'weed' : '')
	});
}
rows.sort(function (a, b) { return b.odds - a.odds || a.steps - b.steps; });

console.log('');
console.log('plant'.padEnd(18) + 'mature at'.padStart(10) + 'steps to grow'.padStart(15) +
	'grown for'.padStart(12) + '   note');
rows.forEach(function (r) {
	console.log(r.name.padEnd(18) +
		String(r.mature).padStart(10) +
		r.steps.toFixed(0).padStart(15) +
		(r.odds * 100).toFixed(1).padStart(11) + '%' +
		(r.note ? '   ' + r.note : ''));
});
console.log('');
console.log('"Grown for" is the share of a replant cycle spent mature: what one');
console.log('of these is worth as a parent on any given garden step.');
console.log('');
