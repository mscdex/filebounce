#!/usr/bin/env node

var http = require('http'),
    https = require('https'),
    urlParse = require('url').parse,
    fs = require('fs');

var Busboy = require('busboy'),
    uuid = require('node-uuid'),
    argv = require('yargs').options({
      'c': {
        alias: 'config',
        requiresArg: true,
        config: true,
        describe: 'Path to JSON config file containing the same options'
      },
      'a': {
        alias: 'address',
        requiresArg: true,
        defaultDescription: 'All addresses',
        describe: 'The network address to listen on'
      },
      'p': {
        alias: 'port',
        requiresArg: true,
        defaultDescription: '80 for HTTP, 443 for HTTPS',
        describe: 'The port number to listen on'
      },
      'ttl': {
        default: 30000,
        requiresArg: true,
        describe: 'How long waiting requests are good for (in milliseconds)'
      },
      'https.ca': {
        requiresArg: true,
        implies: ['https.cert', 'https.key'],
        describe: 'Path to a CA to use'
      },
      'https.cert': {
        type: 'string',
        requiresArg: true,
        implies: ['https.key'],
        describe: 'Path to a certificate to use'
      },
      'https.key': {
        type: 'string',
        requiresArg: true,
        implies: ['https.cert'],
        describe: 'Path to a private key to use'
      },
      'https.pass': {
        type: 'string',
        implies: ['https.key'],
        describe: 'Passphrase for a private key or pfx'
      },
      'https.pfx': {
        type: 'string',
        requiresArg: true,
        describe: 'Path to a pfx file'
      }
    })
    .check(function(argv, aliases) {
      if (Array.isArray(argv['https.pfx']))
        throw new Error('There be only one pfx argument');
      else {
        var pfx = argv['https.pfx'];
        if (pfx && !(argv['https.pfx'] = readFile(pfx)))
          throw new Error('Unable to read pfx file: ' + pfx);
      }

      var passCount = (Array.isArray(argv['https.pass'])
                       ? argv['https.pass'].length
                       : 1),
          keyCount = (Array.isArray(argv['https.key'])
                      ? argv['https.key'].length
                      : 1);
      if (passCount !== keyCount) {
        throw new Error('If you supply a passphrase, you must have one '
                        + 'specified for each private key');
      }

      var ca = argv['https.ca'];
      if (Array.isArray(ca)) {
        ca.forEach(function(f, i) {
          if (!(ca[i] = readFile(f)))
            throw new Error('Unable to read CA file: ' + f);
        });
      } else if (ca && !(argv['https.ca'] = readFile(ca)))
        throw new Error('Unable to read CA file: ' + ca);

      var cert = argv['https.cert'];
      if (Array.isArray(cert)) {
        cert.forEach(function(f, i) {
          if (!(cert[i] = readFile(f)))
            throw new Error('Unable to read cert file: ' + f);
        });
      } else if (cert && !(argv['https.cert'] = readFile(cert)))
        throw new Error('Unable to read cert file: ' + cert);

      var key = argv['https.key'];
      if (Array.isArray(key)) {
        key.forEach(function(f, i) {
          if (!(key[i] = readFile(f)))
            throw new Error('Unable to read private key file: ' + f);
        });
      } else if (key && !(argv['https.key'] = readFile(key)))
        throw new Error('Unable to read private key file: ' + key);

      return true;
    })
    .usage('Usage: $0 [options]')
    .help('h')
    .strict()
    .showHelpOnFail(false, 'Use -h to show options')
    .argv;

var CONFIG = argv,
    MAX_TTL = (typeof CONFIG.ttl === 'number' ? CONFIG.ttl : 30000),
    ADDRESS = CONFIG.address,
    HTTPS = false;

if (CONFIG['https.ca']
    || CONFIG['https.cert']
    || CONFIG['https.key']
    || CONFIG['https.pass']
    || CONFIG['https.pfx']) {
  HTTPS = {
    ca: CONFIG['https.ca'],
    cert: CONFIG['https.cert'],
    key: CONFIG['https.key'],
    passphrase: CONFIG['https.pass'],
    pfx: CONFIG['https.pfx']
  };
}

var PORT = (typeof CONFIG.port === 'number' ? CONFIG.port : (HTTPS ? 443 : 80));

var //TEMP_BAN_TTL = 60000,
    RE_TEXTONLY = /curl|wget/i,
    RE_GETWID_PATH = /^\/getStreamID\/([a-f0-9\-]{36})$/,
    RE_BADCONTYPES = /^application\/x-www-form-urlencoded/i,
    RE_ISMULTIPART = /^multipart\/form-data/,
    RE_HOST_HDR = /^(.+?[^:])(?::(\d+))?$/,
    RE_UPLOAD_TOKEN = /%id%/g,
    RE_HOST_TOKEN = /%host%/g,
    UPLOAD_FORM = '\
      <html>\
        <head>\
          <title>FileBounce :: Select a file to transfer</title>\
          <script>\
            function onSubmit() {\
              var el = document.getElementById("streamLink");\
              el.innerHTML = "";\
              setTimeout(function() {\
                var xhr = new XMLHttpRequest();\
                xhr.open("GET", "/getStreamID/%id%", true);\
                xhr.onreadystatechange = function() {\
                  if (xhr.readyState === 4) {\
                    if (xhr.status === 200) {\
                      var wid = xhr.responseText;\
                      el.innerHTML = "Stream Link: <a href=\'%host%/"\
                                     + wid\
                                     + "\'>"\
                                     + wid\
                                     + "</a><br />";\
                    } else\
                      el.innerHTML = "Unable to retrieve stream link<br />";\
                  }\
                };\
                xhr.send();\
              }, 1000);\
              return true;\
            }\
          </script>\
        </head>\
        <body>\
          <div id="streamLink"></div>\
          <form method="POST" action="/%id%" onsubmit="return onSubmit()" enctype="multipart/form-data">\
            <input type="file" name="bounce"><br />\
            <input type="submit" value="Bounce it!">\
          </form>\
        </body>\
      </html>';

var waiting = {},
    //tempbans = {},
    srv;

function readFile(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } finally {}
}

function respondExpired(res) {
  // Unfortunately not all browsers behave correctly and/or the same, so
  // we just abruply destroy the socket to ensure the browser doesn't
  // get stuck "uploading"
  if (res.writable) {
    var socket = res.socket;
    // Typically browsers will never see the "Bounce expired" message
    // unfortunately and will instead show some built-in error message due to
    // the abrupt socket disconnection. Oh well...
    res.writeHead(410, { 'Connection': 'close', 'Content-Type': 'text/plain' });
    res.end('Bounce expired');
    socket.destroy();
  }
}

function findWaitingByIID(iid) {
  /*if (iid[0] === '*')
    iid = iid.substring(1);
  if (tempbans[iid] !== undefined)
    return;*/
  var ids = Object.keys(waiting);
  for (var i = 0, w; i < ids.length; ++i) {
    id = ids[i];
    w = waiting[id];
    if (w[6] === iid)
      return w;
  }
}

function onRequest(req, res) {
  var method = req.method,
      reqInfo = urlParse(req.url, true),
      path = reqInfo.pathname,
      headers = req.headers,
      m,
      reqHost = (headers.host && (m = RE_HOST_HDR.exec(headers.host))
                 ? m[1]
                 : undefined),
      host = (HTTPS ? 'https://' : 'http://')
             + (reqHost || ADDRESS)
             + ((!HTTPS && PORT === 80)
                || (HTTPS && PORT === 443) ? '' : ':' + PORT),
      wantsJSON = (reqInfo.query.json !== undefined),
      textOnly,
      id;

  if (method === 'POST') {
    // An upload request
    var ua = headers['user-agent'],
        conType = headers['content-type'],
        stream;
    textOnly = ua && RE_TEXTONLY.test(ua);

    if (RE_BADCONTYPES.test(conType)) {
      res.writeHead(400, {
        'Content-Type': (wantsJSON ? 'application/json': 'text/plain')
      });
      if (wantsJSON)
        res.end('{"error":"Bad Content-Type: ' + conType + '"}');
      else
        res.end('Bad Content-Type: ' + conType);
      return;
    } else if (RE_ISMULTIPART.test(conType)) {
      var busboy = new Busboy({ headers: headers });
      busboy.on('file', function(fieldname, file, filename, enc, mime) {
        if (fieldname !== 'bounce' || stream !== undefined)
          return file.resume();

        conType = mime;
        stream = file;
        initialResponse();
      }).on('finish', function() {
        if (stream === undefined) {
          res.writeHead(400, {
            'Content-Type': (wantsJSON ? 'application/json' : 'text/plain')
          });
          if (wantsJSON)
            res.end('{"error":"No file POSTed"}');
          else
            res.end('No file POSTed');
        }
      });
      req.pipe(busboy);
      return;
    } else {
      stream = req;
      initialResponse();
    }

    function initialResponse() {
      var iid;
      if (!textOnly && path.length > 1 && path[0] === '/') {
        iid = path.substring(1);
        /*if (tempbans[iid] !== undefined) {
          // prevent browsers from auto-resubmitting a form multiple times after
          // a bounce expires
          respondExpired(res);
          return;
        }*/
      }

      do {
        id = uuid.v1();
        if (waiting[id] === undefined) {
          res.wantsJSON = wantsJSON;
          waiting[id] = [
            Date.now() + MAX_TTL,
            res,
            conType || 'application/octet-stream',
            stream,
            textOnly,
            id,
            iid
          ];
          break;
        }
      } while (true);

      if (textOnly) {
        res.writeHead(200, {
          'Content-Type': (wantsJSON ? 'application/json' : 'text/plain')
        });
        if (wantsJSON)
          res.write('{"id":"' + id + '","url":"' + host + '/' + id + '"}');
        else
          res.write(host + '/' + id);
      }
    }

    return;
  } else if (method === 'GET' && path !== '/favicon.ico') {
    var w;
    if (m = RE_GETWID_PATH.exec(path)) {
      // A request for an already waiting stream ID
      w = findWaitingByIID(m[1]);
      if (w !== undefined) {
        // Mark the IID (intermediate ID) such that it's not "found" again for a
        // subsequent request, but we can still reference the original value
        // when checking for temporary "bans"
        /*var existingIID = w[6];
        if (existingIID !== undefined && existingIID[0] !== '*')
          w[6] = '*' + existingIID;*/
        w[6] = undefined;
        res.end(w[5]);
        return;
      }
    } else if (path.length > 1 && path[0] === '/') {
      // A download request
      id = path.substring(1);
      w = waiting[id];

      if (w !== undefined) {
        delete waiting[id];
        var resSrc = w[1];
        if (resSrc.writable) {
          textOnly = w[4];
          var recvIP = res.socket.remoteAddress;
          res.writeHead(200, { 'Content-Type': w[2] });
          res.on('finish', function() {
            if (resSrc.wantsJSON)
              resSrc.end('{"message":"File received by ' + recvIP + '"}');
            else {
              resSrc.end(textOnly
                         ? '\n\nFile received by ' + recvIP + '\n'
                         : 'File received by ' + recvIP);
            }
          });
          w[3].pipe(res);
          return;
        }
      }
    } else {
      // Upload request form (to make it easy to transfer a file from a browser)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(UPLOAD_FORM.replace(RE_UPLOAD_TOKEN, uuid.v1())
                         .replace(RE_HOST_TOKEN, host));
      return;
    }
  }

  res.writeHead(404);
  res.end();
}


function onListening() {
  if (ADDRESS == null)
    ADDRESS = this.address().address;
  console.log('FileBounce server listening on ' + ADDRESS + ':' + PORT);
}
ADDRESS
if (HTTPS)
  srv = https.createServer(HTTPS, onRequest);
else
  srv = http.createServer(onRequest);
if (typeof ADDRESS === 'string')
  srv.listen(PORT, ADDRESS, onListening);
else
  srv.listen(PORT, onListening);

setInterval(function() {
  // Check for expired, waiting bounces
  var ids = Object.keys(waiting),
      now = Date.now(),
      id,
      w,
      i;
  for (i = 0; i < ids.length; ++i) {
    id = ids[i];
    w = waiting[id];
    if (w[0] <= now) {
      delete waiting[id];

      var res = w[1],
          textOnly = w[4];
      if (res.writable) {
        if (res.wantsJSON)
          res.end('{"message":"Bounce expired"}');
        else if (textOnly)
          res.end('\n\nBounce expired\n');
        else {
          // browser
          /*var existingIID = w[6];
          if (existingIID !== undefined) {
            if (existingIID[0] === '*')
              existingIID = existingIID.substring(1);
            tempbans[existingIID] = now + TEMP_BAN_TTL;
          }*/
          respondExpired(res);
        }
      }
    }
  }

  // Check for expired, temporary "bans"
  /*var bans = Object.keys(tempbans),
      ban;
  for (i = 0; i < bans.length; ++i) {
    ban = bans[i];
    if (tempbans[ban] <= now)
      delete tempbans[ban];
  }*/
}, 1000);
