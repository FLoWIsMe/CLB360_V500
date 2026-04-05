CLB360 V500 Package

What is included
- index.html
- server.js
- logo.png
- preview images

Recommended use
1. Put all files in one folder.
2. Run: node server.js
3. Open: http://localhost:8080

Why the live endpoint test has to happen on your network
This build can create the UI and wire the requests, but the actual live test depends on the environment where it will run:
- your network needs outbound access to api.ui.com
- DNS and firewall rules must allow the request
- the local browser/server environment must be the same one you will use in production
- the real test confirms each unit API key returns live data and that refresh/report generation works end-to-end

If direct browser access is blocked by CORS or local policy, the included server.js handles the requests server-side.

Support link on the page
- support@clb360.com
- +1 508 425 0605
