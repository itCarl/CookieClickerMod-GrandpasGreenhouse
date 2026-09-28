/**
 * Loads the game's real minigameGarden.js into a sandbox.
 *
 * Nothing about the garden is reimplemented here: this is the shipped file,
 * evaluated against stubs for the DOM and the handful of Game globals it
 * touches, with Math.random replaced by a seeded PRNG so a run repeats.
 *
 * Usage:  var sb = require('./garden.js').boot({seed: 1, level: 9});
 *         sb.M.getMuts(...)      // the game's own function
 *         sb.step()              // one garden step
 */
'use strict';

var fs = require('fs');
var path = require('path');

/*
 * The harness has to work from two places: inside the game tree (where it is
 * reached through a junction as moddev/<Mod>) and inside the git repo (where it
 * sits beside the mod as Code/moddev). The two have different relative layouts,
 * so nothing here assumes one - each path is looked up among the candidates and
 * the first that exists wins.
 */
function firstExisting(candidates, what) {
	for (var i = 0; i < candidates.length; i++) {
		if (fs.existsSync(candidates[i])) return candidates[i];
	}
	throw new Error('cannot find ' + what + ' - looked in:\n  ' + candidates.join('\n  '));
}

var GAME_DIR = 'C:/Program Files (x86)/Steam/steamapps/common/Cookie Clicker/resources/app';

function gameSrc(file) {
	return firstExisting([
		path.join(__dirname, '..', '..', 'src', file),   // moddev/<Mod> in the game tree
		path.join(GAME_DIR, 'src', file)                 // anywhere else
	], 'the game source ' + file);
}

function modMain(name) {
	return firstExisting([
		path.join(__dirname, '..', 'mod', 'main.js'),                        // in the repo
		path.join(__dirname, '..', '..', 'mods', 'local', name, 'main.js'),  // in the game tree
		path.join(GAME_DIR, 'mods', 'local', name, 'main.js')
	], name + '/main.js');
}

var vm = require('vm');

var GAME_SRC = gameSrc('minigameGarden.js');
var MOD_SRC  = modMain('GrandpasGreenhouse');

/** mulberry32 - small, fast, and repeats exactly for a given seed. */
function mulberry(a) {
	return function () {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		var t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * The garden's init() builds its whole panel before it defines anything
 * useful, so the DOM has to answer rather than throw. Every element is the
 * same inert stub, cached by id so repeated lookups agree.
 */
function makeDOM() {
	var byId = {};
	var created = [];
	var root = null;
	function el(id) {
		return {
			id: id || '',
			innerHTML: '', textContent: '', value: '',
			style: {}, dataset: {},
			className: '', isConnected: true, parentNode: null, nextSibling: null,
			children: [], checked: false,
			classList: {add: function () {}, remove: function () {}, contains: function () { return false; }},
			appendChild: function (c) { this.children.push(c); c.parentNode = this; return c; },
			insertBefore: function (c) { this.children.push(c); c.parentNode = this; return c; },
			removeChild: function (c) { return c; },
			addEventListener: function () {},
			setAttribute: function (k, v) { this[k] = v; },
			getAttribute: function (k) { return typeof this[k] === 'string' ? this[k] : null; },
			closest: function () { return null; },
			querySelector: function () { return null; },
			getBoundingClientRect: function () { return {left: 0, top: 0, width: 0, height: 0}; }
		};
	}
	// An element the mod created and gave an id is findable again, the way a
	// real appended node would be - otherwise the mod rebuilds its panel every
	// frame, which no browser does, and anything keyed to "was the panel just
	// built" behaves nothing like the real game. Everything else is an inert
	// placeholder reporting isConnected false, so a mod asking "is my panel
	// still in the document?" gets a truthful no and actually builds it once.
	function get(id) {
		for (var i = created.length - 1; i >= 0; i--) {
			if (created[i].id === id) return created[i];
		}
		if (!byId[id]) { var e = el(id); e.isConnected = false; e.parentNode = root; byId[id] = e; }
		return byId[id];
	}
	root = el('root');
	var doc = {
		getElementById: get,
		createElement: function () { var e = el(''); created.push(e); return e; },
		head: el('head'),
		body: el('body'),
		addEventListener: function () {}
	};
	return {
		doc: doc, get: get, root: root, created: created,
		/** The element the mod created with this id, if it built one. */
		findCreated: function (id) {
			for (var i = created.length - 1; i >= 0; i--) if (created[i].id === id) return created[i];
			return null;
		}
	};
}

function boot(opts) {
	opts = opts || {};
	var rng = mulberry(opts.seed === undefined ? 1 : opts.seed);
	var dom = makeDOM();

	var Game = {
		Objects: {},
		ObjectsById: [],
		cookies: opts.cookies === undefined ? 1e15 : opts.cookies,
		cookiesPs: opts.cookiesPs === undefined ? 1e9 : opts.cookiesPs,
		cookiesPsRawHighest: 1e9,
		fps: 30, drawT: 0, T: 0, version: 2.053, resPath: '',
		mouseX: 0, mouseY: 0, keys: {},
		mods: {},
		Has: function () { return false; },
		HasAchiev: function () { return false; },
		Win: function () {},
		Unlock: function () {},
		Popup: function () {},
		Prompt: function () {},
		ClosePrompt: function () {},
		SparkleAt: function () {},
		// Counted as well as subtracted: a few million off a bank of 1e30 is
		// absorbed by the float, so the balance alone cannot prove a purchase.
		Spend: function (n) { Game.cookies -= n; Game.spentTotal += n; },
		spentTotal: 0,
		Earn: function (n) { Game.cookies += n; },
		auraMult: function () { return 0; },
		dropRateMult: function () { return 1; },
		sayTime: function () { return ''; },
		getDynamicTooltip: function () { return ''; },
		registerMod: function (id, mod) { Game.mods[id] = mod; },
		registerHook: function (name, fn) { (Game.hooks[name] || (Game.hooks[name] = [])).push(fn); },
		hooks: {}
	};
	// The plants' effect strings name several buildings by hand (Cursor,
	// Grandma, ...), so any building asked for has to exist. Only the Farm
	// needs real numbers.
	var buildings = {
		'Farm': {
			id: 2, name: 'Farm', single: 'Farm',
			amount: opts.amount === undefined ? 400 : opts.amount,
			level: opts.level === undefined ? 9 : opts.level,
			minigameName: 'Garden', minigameLoaded: false
		}
	};
	Game.Objects = new Proxy(buildings, {
		get: function (t, k) {
			if (typeof k !== 'string') return t[k];
			if (!t[k]) t[k] = {id: 0, name: k, single: k, amount: 0, level: 1};
			return t[k];
		},
		has: function (t, k) { return true; }
	});
	Game.ObjectsById[2] = Game.Objects['Farm'];

	/*
	 * A garden step is minutes apart in a real game and microseconds apart
	 * here, and the mod tells one step from the next by watching M.nextStep -
	 * which is Date.now() plus the step length. Left on the real clock, two
	 * steps inside the same millisecond look like one, the mod sits out its
	 * turn, and how often that happens depends on how fast the machine is and
	 * on how long the mod's own planner took. That makes every benchmark
	 * unrepeatable. So the sandbox gets a clock the harness winds by hand:
	 * one step, one step's worth of time.
	 */
	var clock = {t: 1700000000000};
	var VDate = function (a) { return arguments.length ? new Date(a) : new Date(clock.t); };
	VDate.now = function () { return clock.t; };
	VDate.parse = Date.parse;
	VDate.UTC = Date.UTC;
	VDate.prototype = Date.prototype;

	var ctx = {
		Game: Game,
		Math: Math,
		document: dom.doc,
		window: {},
		console: console,
		Date: VDate,
		JSON: JSON,
		Array: Array, Object: Object, String: String, Number: Number, Boolean: Boolean,
		setTimeout: function () {}, clearTimeout: function () {},
		EN: 1,
		l: dom.get,
		loc: function (s, args) { return String(s); },
		cap: function (s) { return String(s); },
		FindLocStringByPart: function (s) { return String(s); },
		AddEvent: function () {},
		PlaySound: function () {},
		Beautify: function (n) { return String(Math.round(n)); },
		LBeautify: function (n) { return String(Math.round(n)); },
		choose: function (arr) { return arr[Math.floor(rng() * arr.length)]; },
		randomFloor: function (x) { return Math.floor(x) + (rng() < (x % 1) ? 1 : 0); },
		rand: rng
	};
	ctx.globalThis = ctx;
	vm.createContext(ctx);

	// Seed the PRNG the game reaches for. Math is shared with the host realm,
	// so patch it inside the context only.
	vm.runInContext('Math = Object.create(Math); Math.random = rand;', ctx);

	var src = fs.readFileSync(GAME_SRC, 'utf8').replace(/^﻿/, '');
	vm.runInContext(src, ctx, {filename: 'minigameGarden.js'});

	var M = Game.Objects['Farm'].minigame;
	M.launch();
	Game.Objects['Farm'].minigameLoaded = true;

	function loadMod() {
		var modSrc = fs.readFileSync(MOD_SRC, 'utf8');
		vm.runInContext(modSrc, ctx, {filename: 'GrandpasGreenhouse/main.js'});
		var mod = Game.mods['grandpas greenhouse'];
		mod.init();
		return mod;
	}

	/** One garden step, exactly as the game's own logic hook would run it. */
	function step() {
		clock.t += Math.max(1, Math.round((M.stepT || 60) * 1000));
		M.nextStep = 0;                       // force the step
		M.logic();
		var hooks = Game.hooks['logic'] || [];
		for (var i = 0; i < hooks.length; i++) hooks[i]();
	}

	function plant(key, x, y, age) {
		var p = M.plants[key];
		M.plot[y][x] = [p.id + 1, age === undefined ? Math.ceil(p.mature) : age];
	}

	function clear() {
		for (var y = 0; y < 6; y++) for (var x = 0; x < 6; x++) M.plot[y][x] = [0, 0];
	}

	function unlock(keys) {
		for (var i = 0; i < keys.length; i++) M.plants[keys[i]].unlocked = 1;
		M.getUnlockedN();
	}

	function unlockedCount() {
		var n = 0;
		for (var k in M.plants) if (M.plants[k].unlocked) n++;
		return n;
	}

	return {
		Game: Game, M: M, ctx: ctx, rng: rng, dom: dom,
		loadMod: loadMod, step: step, plant: plant, clear: clear,
		unlock: unlock, unlockedCount: unlockedCount
	};
}

module.exports = {boot: boot, mulberry: mulberry};
