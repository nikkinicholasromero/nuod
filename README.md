# nuod

A static browser for publicly available live streams indexed by [IPTV-org](https://github.com/iptv-org/iptv).

## Run locally

Open `index.html` in a modern browser, or serve this folder with any static server. No build step or environment variables are required.

## Deploy to Vercel

Import this folder as a Vercel project. Vercel will detect it as a static site and serve the files directly.

## Notes

- Channel metadata and stream links are fetched live from the official IPTV-org API.
- HLS streams are played with hls.js when a browser does not natively support HLS.
- Individual broadcasters may apply geo-restrictions, CORS rules, or other playback constraints.
