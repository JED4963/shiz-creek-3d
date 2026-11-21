# Shiz Creek 3D (online version)

The game page plus its small multiplayer server.

- `index.html` is the whole game (built from the `src` folder of the project with `node build.js`).
- `server.js` serves that page and runs the multiplayer rooms. It needs nothing installed besides Node.
- `package.json` tells a hosting service how to start it.

To run it on a hosting service: build command `npm install`, start command `node server.js`.
To run it on your own computer: `node server.js`, then open http://localhost:8080
