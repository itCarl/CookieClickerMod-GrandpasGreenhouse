/*
 * Serves the game's resources/app over http so a browser can run it, with two
 * overrides:
 *   /steam/steam.js  -> a shim, because the real one talks to Electron's preload
 *   /shot/save.txt   -> the player's save, read only, never written back
 */
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');

var ROOT = 'C:/Program Files (x86)/Steam/steamapps/common/Cookie Clicker/resources/app';
var PORT = Number(process.argv[2] || 8099);

var TYPES = {
	'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
	'.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg',
	'.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
	'.ttf': 'font/ttf', '.txt': 'text/plain', '.json': 'application/json'
};

var STEAM_SHIM = [
	'/* shim: the real steam.js needs Electron\'s preload bridge */',
	'showAds=false;',
	'Music=false;',
	'var App=0;'
].join('\n');

http.createServer(function (req, res) {
	var url = decodeURIComponent(req.url.split('?')[0]);

	if (url === '/steam/steam.js') {
		res.writeHead(200, {'Content-Type': 'text/javascript'});
		return res.end(STEAM_SHIM);
	}
	if (url === '/shot/save.txt') {
		res.writeHead(200, {'Content-Type': 'text/plain'});
		return res.end(fs.readFileSync(path.join(ROOT, 'save', 'save.cki'), 'utf8'));
	}

	var file = path.join(ROOT, url);
	if (file.indexOf(path.normalize(ROOT)) !== 0) { res.writeHead(403); return res.end(); }
	fs.readFile(file, function (err, buf) {
		if (err) { res.writeHead(404); return res.end('404 ' + url); }
		res.writeHead(200, {'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'});
		res.end(buf);
	});
}).listen(PORT, '127.0.0.1', function () {
	console.log('serving ' + ROOT + ' on http://127.0.0.1:' + PORT + '/src/index.html');
});
