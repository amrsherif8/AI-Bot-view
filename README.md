# Funke Demo

A frontend-only showcase of the Funke Robot project. It uses HTML, CSS, and vanilla JavaScript and runs as a static site.

## Run locally

Open `index.html` directly in a modern browser. No server, package installation, login, or account is required.

The 3D viewer uses the original Funke GLB model. Its bytes are embedded in `assets/funke-model-data.js` so the model can load from a `file://` page without a local server.

## Demo behavior

Robot controls, voice input, translation, math, sound, microphone, media, document, and AI actions are presentation-only. They do not record from the microphone, play project audio, upload files, or contact any service. Demo actions show an on-page notice. The 3D model can be rotated and its parts selected locally in the browser.

The showcase makes no API requests and includes no backend, database, authentication, login, or registration code. The theme switch and demo chat are local interface previews.

## Set the original website link

In `index.html`, find the “Access Original Version” link and replace this placeholder:

```text
https://YOUR-ORIGINAL-WEBSITE-LINK.com
```

The same location is marked with an HTML comment directly above the link.

## Included assets

- `assets/icon-on-dark.png` and `assets/icon-on-light.png`: Funke brand icon from the original project.
- `assets/favicon.png`: original favicon.
- `assets/funke-viewer.js`: local-only copy of the original vanilla WebGL viewer, adapted to read the embedded model buffer rather than fetch a file.
- `assets/funke-model-data.js`: embedded original `FUNKE_V2.0.glb` data for standalone opening.
