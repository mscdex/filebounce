Description
===========

A server written in node.js for streaming/"bouncing" files from point A to point
B via a short-lived, unique, shareable web link.

Files are never stored on the server as data merely passes through it between
the sender and recipient, without touching the disk.


Requirements
============

* [node.js](http://nodejs.org/) -- v0.10.0 or newer


Install
=======

    npm install filebounce -g


Usage
=====

After installation, you can use `fb` or `filebounce` to start a server.
By default with no arguments, the server listens on all network interfaces for
HTTP requests on port 80.

Here's an example that uses cURL:

Sender:
```
# curl -X POST -H "Content-Type: application/x-gzip" --data-binary @foo.tar.gz http://myfbserver
http://myfbserver/8ae9f610-dd48-11e4-820f-99adafb782b6
```

Receiver:
```
# curl http://myfbserver/8ae9f610-dd48-11e4-820f-99adafb782b6 | tar zx
```

Then once the file transfer has completed, the Sender will see something like
this after the file url:

```

File received by 192.168.1.5
```

For graphical browsers, if you navigate to `http://myfbserver` you will be
prompted with a form with a file field. There you can select the file and submit
it. Shortly after a link will appear at the top of the page containing a link
to the file stream.

Similarly you can navigate to a shared file stream URL in a graphical browser
and the browser will either download it or render it in some way (depending on
the file's `Content-Type` and how the browser handles that file type).



If a waiting file stream expires, the sender will be "notified" and the file
stream link will no longer be valid. The kind of notification depends on whether
you're using a CLI client like cURL or you are sending from a graphical browser:

* Sending from a CLI client will show a "Bounce expired." message and the
request will be terminated.

* Sending from a browser will result in an abrupt termination at the socket
level which will typically result in a "connection lost" type of message in the
browser window. Unfortunately this is a necessary unpleasantry due to the way
that at least *some* browsers behave when uploading a file and the server
responds with an HTTP error status code: those browsers will actually re-submit
the file (even if responding with a 413 for example) at least a few times before
giving up (which is a waste) and what the browser displays after it gives up is
browser-dependent also.


Command-line Options
====================

```
-c, --config   Path to JSON config file containing these same options
-a, --address  The network address to listen on       [default: All addresses]
-p, --port     The port number to listen on
                                         [default: 80 for HTTP, 443 for HTTPS]
--ttl          How long waiting requests are good for (in milliseconds)
                                                              [default: 30000]
--https.ca     Path to a CA to use
--https.cert   Path to a certificate to use                           [string]
--https.key    Path to a private key to use                           [string]
--https.pass   Passphrase for a private key or pfx                    [string]
--https.pfx    Path to a pfx file                                     [string]
-h             Show help
```