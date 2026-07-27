## this is my personal site, running on cloudflare workers w/ static assets

it uses no frameworks, is static and tries to mash my favorite bits of the windows I grew up on, google chrome flags, and really fast sites like mcmaster

for instance: 
* the photos are encoded as avifs and jpegs with lots of care and the html, js, and css are all served as minified but with nonminified mirrors
* brotli q11 where possible and also trying to use shared dictionaries with deltas on zstandard
* encrypted client hello and quic are used
