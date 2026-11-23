# Shiz Creek 3D

A 3D fishing game set in the town of Hannaford: catch fish, sell them, buy better gear and boats, and get up to no good on the side. It runs in the browser with nothing to install, and up to 32 people can share one town.

## What is here

- `index.html` is the whole game in one file.
- `server.js` hands out that page and runs the multiplayer rooms. It needs nothing installed besides Node.
- `package.json` tells a hosting service how to start it.

## Running it

On a hosting service (Render, for example): build command `npm install`, start command `node server.js`. The address the service gives you is the game: open it, press **PLAY**, then **Friends → Join the town server** to share a world with everyone else who opens the same address.

On your own computer: `node server.js`, then open http://localhost:8080. People on the same Wi-Fi can join at your computer's address on port 8080.

Single player needs no server at all: open `index.html` in Chrome or Edge.

## Controls

WASD move · Shift run · drag to look · Space cast and reel · E interact · G take a vehicle · B boat · M map · L quests · Esc menu
